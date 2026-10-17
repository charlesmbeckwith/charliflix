using System;
using System.Threading;
using System.Threading.Tasks;

namespace ChannelRoomDesktop
{
    // The updater accepts actions, never paths or URLs supplied by web content.
    internal interface IDesktopUpdateBackend
    {
        bool IsInstalled { get; }
        string CurrentVersion { get; }
        Task<string> CheckAsync();
        Task DownloadAsync(Action<int> progress, CancellationToken cancellationToken);
        void ApplyAndRestart();
    }

    internal sealed class DesktopUpdateState
    {
        public string type { get { return "charliflix-updater"; } }
        public string status { get; internal set; }
        public string currentVersion { get; internal set; }
        public string latestVersion { get; internal set; }
        public int progress { get; internal set; }
        public string message { get; internal set; }
        public bool automatic { get; internal set; }
    }

    internal sealed class DesktopUpdateController : IDisposable
    {
        private readonly IDesktopUpdateBackend backend;
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private bool busy;
        private bool disposed;
        private bool restarting;
        private string latest;
        private bool automaticCheck;
        private DesktopUpdateState state;

        internal event Action<DesktopUpdateState> StateChanged;

        internal DesktopUpdateController(IDesktopUpdateBackend backend)
        {
            this.backend = backend;
            SetState(backend.IsInstalled ? "idle" : "unsupported", 0, null);
        }

        internal DesktopUpdateState State { get { return state; } }
        internal bool IsManaged { get { return !disposed && backend.IsInstalled; } }
        internal bool CanRestart { get { return IsManaged && !busy && !restarting && state.status == "ready"; } }

        internal static bool IsTrustedMessageSource(string source, string document, string origin)
        {
            Uri first;
            Uri second;
            if (!Uri.TryCreate(source, UriKind.Absolute, out first) || !Uri.TryCreate(document, UriKind.Absolute, out second)) return false;
            return first.Scheme == "http" && first.GetLeftPart(UriPartial.Authority) == origin &&
                second.Scheme == "http" && second.GetLeftPart(UriPartial.Authority) == origin &&
                (first.AbsolutePath == "/" || first.AbsolutePath == "/index.html") &&
                (second.AbsolutePath == "/" || second.AbsolutePath == "/index.html") &&
                String.IsNullOrEmpty(first.UserInfo) && String.IsNullOrEmpty(second.UserInfo) &&
                String.IsNullOrEmpty(first.Query) && String.IsNullOrEmpty(second.Query) &&
                String.IsNullOrEmpty(first.Fragment) && String.IsNullOrEmpty(second.Fragment);
        }

        internal static bool IsAction(string value)
        {
            return value == "status" || value == "check" || value == "restart";
        }

        internal async Task CheckAsync(bool automatic = false)
        {
            if (!IsManaged || busy || restarting || state.status == "ready") return;
            busy = true;
            automaticCheck = automatic;
            try
            {
                SetState("checking", 0, null);
                latest = await backend.CheckAsync();
                if (disposed) return;
                if (latest == null) { SetState("current", 0, null); return; }
                SetState("downloading", 0, null);
                await backend.DownloadAsync(delegate(int progress) {
                    if (!disposed) SetState("downloading", Math.Max(0, Math.Min(100, progress)), null);
                }, lifetime.Token);
                if (!disposed) SetState("ready", 100, null);
            }
            catch (OperationCanceledException) { if (!disposed) SetState("error", 0, "The update download was cancelled. Try again later."); }
            catch (Exception) { if (!disposed) SetState("error", 0, "Updates could not be checked or downloaded. Try again later."); }
            finally { busy = false; }
        }

        internal async Task<bool> RestartAsync(Func<Task> shutdown)
        {
            if (!CanRestart) return false;
            restarting = true;
            try
            {
                SetState("restarting", 100, null);
                // Do not start Update.exe while WebView2 or our Node bridge holds app files.
                await shutdown();
                if (disposed || !backend.IsInstalled) return false;
                backend.ApplyAndRestart();
                return true;
            }
            catch (Exception)
            {
                if (!disposed) SetState("error", 0, "The update could not restart Charliflix. Close it and try again.");
                return false;
            }
            finally { restarting = false; }
        }

        private void SetState(string status, int progress, string message)
        {
            state = new DesktopUpdateState { status = status, currentVersion = backend.CurrentVersion, latestVersion = latest, progress = progress, message = message, automatic = automaticCheck };
            var changed = StateChanged;
            if (changed != null) changed(state);
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            lifetime.Cancel();
            lifetime.Dispose();
        }
    }
}
