using System;
using System.Threading.Tasks;
using ChannelRoomDesktop;

internal static class DesktopStartupChecks
{
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task<Exception> Failure(Task<string> task)
    {
        try { await task; throw new Exception("Expected a startup failure."); }
        catch (InvalidOperationException error) { return error; }
    }

    private static async Task Run(string name)
    {
        if (name == "loopback-origin")
        {
            foreach (string address in new[] { "http://127.0.0.1:8767", "http://127.0.0.1:47819/", "http://127.0.0.1:1", "http://127.0.0.1:65535" })
            {
                string origin;
                Assert(DesktopHostStartup.TryLoopbackOrigin(address, out origin), "A valid owned loopback origin was rejected: " + address);
                Assert(!origin.EndsWith("/"), "The native origin should be normalized without a trailing slash.");
            }
            foreach (string address in new[] { null, "", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:-1", "http://127.0.0.1:08767", "https://127.0.0.1:8767", "http://localhost:8767", "http://127.0.0.2:8767", "http://127.0.0.1.example.com:8767", "http://person@127.0.0.1:8767", "http://127.0.0.1:8767/index.html", "http://127.0.0.1:8767/../", "http://127.0.0.1:8767/?restart", "http://127.0.0.1:8767/#fragment", "http://127.0.0.1:8767\n", "file:///index.html" })
            {
                string origin;
                Assert(!DesktopHostStartup.TryLoopbackOrigin(address, out origin), "An untrusted bridge URL was accepted: " + address);
                Assert(origin == null, "Rejected URLs must not return an origin.");
            }
            return;
        }

        var startup = new DesktopHostStartup("C:\\fixture\\desktop.log");
        if (name == "exit-before-error")
        {
            // Deterministic ordering reproduces Exited beating OutputDataReceived.
            var exit = startup.ExitedAsync(1);
            Assert(!startup.Ready.IsCompleted, "Exited completed startup before stdout was drained.");
            var expected = new InvalidOperationException("Another version or installation of Charliflix is running.");
            Assert(startup.Fail(expected), "The bridge's specific failure did not win.");
            startup.OutputClosed();
            startup.ErrorClosed();
            await exit;
            Assert(Object.ReferenceEquals(await Failure(startup.Ready), expected), "The generic exit failure replaced the actionable bridge error.");
        }
        else if (name == "both-streams-drained")
        {
            var exit = startup.ExitedAsync(7);
            startup.OutputClosed();
            Assert(!startup.Ready.IsCompleted, "The exit fallback ignored pending stderr.");
            startup.ErrorLine("SyntaxError: a backend module could not load");
            startup.ErrorClosed();
            await exit;
            var error = await Failure(startup.Ready);
            Assert(error.Message.Contains("exit code 7") && error.Message.Contains("C:\\fixture\\desktop.log"), "The fallback omitted the exit code or diagnostic path.");
            Assert(error.InnerException != null && error.InnerException.Message.Contains("SyntaxError"), "Pending stderr was not retained for logging.");
        }
        else if (name == "eof-before-exit")
        {
            startup.OutputClosed();
            startup.ErrorClosed();
            Assert(!startup.Ready.IsCompleted, "EOF alone completed startup without a process result.");
            await startup.ExitedAsync(1);
            Assert((await Failure(startup.Ready)).Message.Contains("exit code 1"), "EOF-before-exit lost the failure.");
        }
        else if (name == "ready-preserved")
        {
            Assert(startup.TryReady("http://127.0.0.1:47819"), "A valid readiness result was rejected.");
            var exit = startup.ExitedAsync(0);
            startup.OutputClosed();
            startup.ErrorClosed();
            await exit;
            Assert(await startup.Ready == "http://127.0.0.1:47819", "An exit notification replaced successful readiness.");
        }
        else if (name == "stderr-bounded")
        {
            startup.ErrorLine(new string('A', 20000));
            startup.ErrorLine("The useful final diagnostic.");
            startup.OutputClosed();
            startup.ErrorClosed();
            await startup.ExitedAsync(null);
            var error = await Failure(startup.Ready);
            Assert(error.InnerException.Message.Length <= 8192 && error.InnerException.Message.Contains("useful final diagnostic"), "The stderr tail was not bounded or lost its latest details.");
        }
        else throw new Exception("Unknown test name.");
    }

    private static int Main(string[] args)
    {
        try { Run(args[0]).GetAwaiter().GetResult(); Console.WriteLine(args[0] + " passed"); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
