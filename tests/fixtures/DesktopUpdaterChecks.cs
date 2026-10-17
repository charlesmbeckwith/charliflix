using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using ChannelRoomDesktop;

internal sealed class FakeUpdateBackend : IDesktopUpdateBackend
{
    internal bool installed = true;
    internal int checks;
    internal int downloads;
    internal int applies;
    internal string available = "0.3.1";
    internal TaskCompletionSource<string> checkGate;
    internal TaskCompletionSource<bool> downloadGate;
    internal readonly TaskCompletionSource<bool> downloadStarted = new TaskCompletionSource<bool>();
    internal readonly List<string> order = new List<string>();
    public bool IsInstalled { get { return installed; } }
    public string CurrentVersion { get { return "0.3.0"; } }
    public Task<string> CheckAsync() { checks++; return checkGate == null ? Task.FromResult(available) : checkGate.Task; }
    public async Task DownloadAsync(Action<int> progress, CancellationToken token)
    {
        downloads++;
        downloadStarted.TrySetResult(true);
        progress(25);
        if (downloadGate != null) await downloadGate.Task;
        token.ThrowIfCancellationRequested();
        progress(100);
    }
    public void ApplyAndRestart() { applies++; order.Add("apply"); }
}

internal static class DesktopUpdaterChecks
{
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Run(string name)
    {
        if (name == "source-guard")
        {
            const string origin = "http://127.0.0.1:8767";
            Assert(DesktopUpdateController.IsTrustedMessageSource(origin + "/", origin + "/index.html", origin), "The own app document was rejected.");
            foreach (string source in new[] { "https://example.com/", "http://127.0.0.1:8768/", origin + "/app.js", origin + "/?action=restart", origin + "/#restart", "http://person@127.0.0.1:8767/", "file:///index.html" })
                Assert(!DesktopUpdateController.IsTrustedMessageSource(source, origin + "/", origin), "Untrusted source accepted: " + source);
            Assert(!DesktopUpdateController.IsTrustedMessageSource(origin + "/", "https://example.com/", origin), "A navigated document was trusted.");
            Assert(DesktopUpdateController.IsAction("status") && DesktopUpdateController.IsAction("check") && DesktopUpdateController.IsAction("restart"), "A supported action was rejected.");
            foreach (string action in new[] { "execute", "download", "https://example.com/", "C:\\payload.exe", "RESTART", null }) Assert(!DesktopUpdateController.IsAction(action), "An arbitrary action was accepted.");
            return;
        }

        var backend = new FakeUpdateBackend();
        var controller = new DesktopUpdateController(backend);
        var states = new List<DesktopUpdateState>();
        controller.StateChanged += states.Add;
        try
        {
            if (name == "unmanaged")
            {
                backend.installed = false;
                controller.Dispose();
                controller = new DesktopUpdateController(backend);
                Assert(controller.State.status == "unsupported", "A checkout must offer the manual update path.");
                await controller.CheckAsync();
                bool shutdownCalled = false;
                Assert(!await controller.RestartAsync(delegate { shutdownCalled = true; return Task.FromResult(true); }), "An unmanaged build restarted.");
                Assert(backend.checks == 0 && backend.downloads == 0 && backend.applies == 0 && !shutdownCalled, "An unmanaged build reached update side effects.");
            }
            else if (name == "download")
            {
                Assert(controller.State.status == "idle", "Managed startup must advertise updater support.");
                await controller.CheckAsync(true);
                Assert(controller.State.status == "ready" && controller.CanRestart && controller.State.latestVersion == "0.3.1", "A verified update did not become ready.");
                Assert(states.Count == 5 && states[0].status == "checking" && states[0].automatic && states[1].status == "downloading" && states[4].status == "ready", "Update progress states were unexpected.");
                Assert(backend.applies == 0, "A background download installed without a user action.");
            }
            else if (name == "restart-order")
            {
                await controller.CheckAsync();
                var shutdown = new TaskCompletionSource<bool>();
                var restart = controller.RestartAsync(delegate { backend.order.Add("shutdown"); return shutdown.Task; });
                Assert(backend.applies == 0 && controller.State.status == "restarting", "An update applied before shutdown finished.");
                shutdown.SetResult(true);
                Assert(await restart && backend.applies == 1 && String.Join(",", backend.order) == "shutdown,apply", "Shutdown must precede update apply.");
            }
            else if (name == "failed-shutdown")
            {
                await controller.CheckAsync();
                bool result = await controller.RestartAsync(delegate { throw new InvalidOperationException("A backend process is still running."); });
                Assert(!result && backend.applies == 0 && controller.State.status == "error", "A cleanup failure must prevent installation.");
            }
            else if (name == "normal-close")
            {
                backend.downloadGate = new TaskCompletionSource<bool>();
                var check = controller.CheckAsync();
                await backend.downloadStarted.Task;
                controller.Dispose();
                backend.downloadGate.SetResult(true);
                await check;
                Assert(!controller.CanRestart && controller.State.status != "ready" && backend.applies == 0, "Normal close must cancel updates without installing.");
                Assert(!await controller.RestartAsync(delegate { throw new Exception("A closed updater invoked shutdown."); }), "Disposed updater restarted.");
            }
            else if (name == "deduplicate")
            {
                backend.checkGate = new TaskCompletionSource<string>();
                var first = controller.CheckAsync();
                await controller.CheckAsync();
                Assert(backend.checks == 1, "Concurrent checks were not coalesced.");
                Assert(!await controller.RestartAsync(delegate { throw new Exception("Restart while checking."); }), "Restart was allowed before download.");
                backend.checkGate.SetResult("0.3.1");
                await first;
                await controller.CheckAsync();
                Assert(backend.checks == 1 && backend.downloads == 1, "A ready update was downloaded again.");
            }
            else if (name == "current")
            {
                backend.available = null;
                await controller.CheckAsync();
                Assert(controller.State.status == "current" && !controller.CanRestart && backend.downloads == 0, "A current install should not download or restart.");
            }
            else throw new Exception("Unknown test name.");
        }
        finally { controller.Dispose(); }
    }

    private static int Main(string[] args)
    {
        try { Run(args[0]).GetAwaiter().GetResult(); Console.WriteLine(args[0] + " passed"); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
