using System;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace ChannelRoomDesktop
{
    internal sealed class DesktopHostStartup
    {
        private readonly TaskCompletionSource<string> ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> outputEnded = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> errorEnded = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly StringBuilder stderr = new StringBuilder();
        private readonly string logPath;
        private readonly object stderrLock = new object();

        internal DesktopHostStartup(string logPath) { this.logPath = logPath; }
        internal Task<string> Ready { get { return ready.Task; } }
        internal bool TryReady(string origin) { return ready.TrySetResult(origin); }
        internal bool Fail(Exception error) { return ready.TrySetException(error); }
        internal void OutputClosed() { outputEnded.TrySetResult(true); }
        internal void ErrorClosed() { errorEnded.TrySetResult(true); }

        internal void ErrorLine(string line)
        {
            if (String.IsNullOrEmpty(line)) return;
            lock (stderrLock)
            {
                stderr.AppendLine(line);
                if (stderr.Length > 8192) stderr.Remove(0, stderr.Length - 8192);
            }
        }

        internal async Task ExitedAsync(int? exitCode)
        {
            // Process.Exited may run before the queued stdout handler. Drain both
            // streams so the bridge's actual startup error wins over this fallback.
            await Task.WhenAll(outputEnded.Task, errorEnded.Task).ConfigureAwait(false);
            string details;
            lock (stderrLock) details = stderr.ToString();
            var cause = details.Length == 0 ? null : new InvalidOperationException(details);
            Fail(new InvalidOperationException("The local player exited before it was ready" +
                (exitCode.HasValue ? " (exit code " + exitCode.Value + ")" : "") +
                ". Try opening Charliflix again. Details are in " + logPath, cause));
        }

        internal static bool TryLoopbackOrigin(string address, out string origin)
        {
            origin = null;
            if (String.IsNullOrEmpty(address) || address.Length > 64) return false;
            var match = Regex.Match(address, @"\Ahttp://127\.0\.0\.1:([1-9][0-9]{0,4})/?\z", RegexOptions.CultureInvariant);
            int port;
            Uri uri;
            if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out port) || port > 65535 ||
                !Uri.TryCreate(address, UriKind.Absolute, out uri)) return false;
            origin = uri.GetLeftPart(UriPartial.Authority);
            return true;
        }
    }
}
