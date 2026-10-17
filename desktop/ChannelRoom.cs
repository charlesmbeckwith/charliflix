using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Velopack;

[assembly: AssemblyTitle("Charliflix")]
[assembly: AssemblyDescription("Charliflix local TV player")]
[assembly: AssemblyProduct("Charliflix")]

namespace ChannelRoomDesktop
{
    internal static class Program
    {
        internal const string AppId = "ChannelRoom.Desktop";
        internal static readonly string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        internal static string RuntimeDirectory = Path.Combine(Root, ".runtime");
        internal static readonly string Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                // Hooks must exit before creating a window or starting the streaming backend.
                // Applying a prepared update still requires the user's Restart action.
                VelopackApp.Build().SetAppUserModelId(AppId).SetAutoApplyOnStartup(false).Run();
                if (args.Length == 2 && args[0] == "--shortcut")
                {
                    ShortcutInstaller.Create(Application.ExecutablePath, Path.GetFullPath(args[1]), AppId);
                    return 0;
                }
                if (args.Length == 2 && args[0] == "--check")
                {
                    string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
                    string node = FindNode();
                    var updateBackend = new VelopackUpdateBackend(Version);
                    File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(new { application = "channel-room-desktop", runtime = version, node = node, root = Root, appId = AppId, applicationVersion = Version, managedUpdates = updateBackend.IsInstalled }));
                    return 0;
                }
                bool first;
                using (var mutex = new Mutex(true, @"Local\ChannelRoom.Desktop.Window", out first))
                {
                    if (!first)
                    {
                        IntPtr previous = FindWindow(null, "Charliflix");
                        if (previous == IntPtr.Zero) previous = FindWindow(null, "Channel Room");
                        if (previous != IntPtr.Zero) { if (IsIconic(previous)) ShowWindow(previous, 9); SetForegroundWindow(previous); }
                        return 0;
                    }
                    Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(AppId));
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new PlayerWindow());
                    mutex.ReleaseMutex();
                }
                return 0;
            }
            catch (Exception error)
            {
                if (args.Length == 2 && args[0] == "--check") { File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(new { error = error.Message })); return 1; }
                if (args.Length == 2 && args[0] == "--shortcut") return 1;
                MessageBox.Show("Charliflix could not open.\n\n" + error.Message, "Charliflix", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        internal static string FindNode()
        {
            string bundled = Path.Combine(Root, "desktop", "runtime", "node.exe");
            if (File.Exists(bundled)) return bundled;
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            if (File.Exists(installed)) return installed;
            foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
            {
                try { string candidate = Path.Combine(directory.Trim('"'), "node.exe"); if (File.Exists(candidate)) return Path.GetFullPath(candidate); } catch (ArgumentException) { }
            }
            throw new FileNotFoundException("Node.js 22 or newer is required. Install Node.js and open Charliflix again.");
        }
    }

    internal sealed class PlayerWindow : Form
    {
        private readonly Label notice;
        private WebView2 web;
        private Process host;
        private bool hostOwnsServer;
        private bool hostCleanupFailed;
        private bool hostCleanupConfirmed;
        private readonly TaskCompletionSource<string> ready = new TaskCompletionSource<string>();
        private bool closing;
        private bool closeComplete;
        private bool fullscreen;
        private Rectangle previousBounds;
        private FormWindowState previousState;
        private string origin;
        private readonly DesktopUpdateController updater;
        private readonly System.Windows.Forms.Timer updateTimer;

        internal PlayerWindow()
        {
            updater = new DesktopUpdateController(new VelopackUpdateBackend(Program.Version));
            if (updater.IsManaged) Program.RuntimeDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Charliflix", "user-data");
            updater.StateChanged += PublishUpdateState;
            updateTimer = new System.Windows.Forms.Timer { Interval = 10000 };
            updateTimer.Tick += async delegate {
                updateTimer.Interval = 4 * 60 * 60 * 1000;
                if (!closing) await updater.CheckAsync(true);
            };
            Text = "Charliflix";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Color.FromArgb(12, 15, 20);
            ForeColor = Color.FromArgb(244, 245, 247);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(1280, 850);
            MinimumSize = new Size(900, 620);
            StartPosition = FormStartPosition.CenterScreen;
            notice = new Label { Dock = DockStyle.Fill, Text = "Opening Charliflix…", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 13), Padding = new Padding(40) };
            Controls.Add(notice);
            Shown += async delegate { await OpenPlayerAsync(); };
            FormClosing += OnClosing;
        }

        private async Task OpenPlayerAsync()
        {
            try
            {
                var info = new ProcessStartInfo(Program.FindNode(), "\"" + Path.Combine(Program.Root, "desktop", "host.cjs") + "\"") {
                    WorkingDirectory = Program.Root, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                };
                info.EnvironmentVariables["CHANNEL_ROOM_PORT"] = "8767";
                info.EnvironmentVariables["CHANNEL_ROOM_RUNTIME_DIR"] = Program.RuntimeDirectory;
                host = new Process { StartInfo = info, EnableRaisingEvents = true };
                host.OutputDataReceived += OnHostMessage;
                host.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!String.IsNullOrEmpty(e.Data)) Log(e.Data); };
                host.Exited += delegate { ready.TrySetException(new InvalidOperationException("The local player could not start. Try opening Charliflix again.")); };
                host.Start();
                host.BeginOutputReadLine();
                host.BeginErrorReadLine();
                var completed = await Task.WhenAny(ready.Task, Task.Delay(20000));
                if (completed != ready.Task) throw new TimeoutException("The local player took too long to start. Close this window and try again.");
                origin = await ready.Task;
                if (closing) return;
                web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor, Visible = false };
                Controls.Add(web);
                web.BringToFront();
                string profile = Path.Combine(Program.RuntimeDirectory, "desktop-profile");
                var environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await web.EnsureCoreWebView2Async(environment);
                if (closing) return;
                var core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.WebMessageReceived += OnUpdateMessage;
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!IsLocalPage(e.Uri)) e.Cancel = true; };
                core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) {
                    e.Handled = true;
                    if (e.IsUserInitiated && IsLocalPage(core.Source) && IsReleasePage(e.Uri)) {
                        try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
                        catch (Exception error) { Log("The release page could not open: " + error.Message); }
                    }
                };
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
                core.ContainsFullScreenElementChanged += delegate { SetFullscreen(core.ContainsFullScreenElement); };
                core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                    if (closing) return;
                    if (e.IsSuccess) { notice.Visible = false; web.Visible = true; web.Focus(); PublishUpdateState(updater.State); }
                    else ShowFailure("The local player could not load. Close this window and try again.");
                };
                core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs e) {
                    if (!closing && (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)) ShowFailure("The video window stopped responding. Close Charliflix and open it again.");
                };
                core.Navigate(origin + "/");
                if (updater.IsManaged) updateTimer.Start();
            }
            catch (Exception error) { if (!closing) ShowFailure(error is WebView2RuntimeNotFoundException ? "Microsoft Edge WebView2 Runtime is required. Install the Evergreen Runtime from Microsoft, then open Charliflix again." : error.Message); }
        }

        private bool IsLocalPage(string address)
        {
            Uri uri;
            return Uri.TryCreate(address, UriKind.Absolute, out uri) && uri.Scheme == "http" && uri.GetLeftPart(UriPartial.Authority) == origin && (uri.AbsolutePath == "/" || uri.AbsolutePath == "/index.html") && String.IsNullOrEmpty(uri.UserInfo) && String.IsNullOrEmpty(uri.Query) && String.IsNullOrEmpty(uri.Fragment);
        }

        private async void OnUpdateMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closing || web == null || web.CoreWebView2 == null || !DesktopUpdateController.IsTrustedMessageSource(e.Source, web.CoreWebView2.Source, origin)) return;
            try
            {
                string json = e.WebMessageAsJson;
                if (json.Length > 512) return;
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object type;
                object action;
                if (data == null || data.Count != 2 || !data.TryGetValue("type", out type) || !data.TryGetValue("action", out action) || !(type is string) || !(action is string) || (string)type != "charliflix-updater" || !DesktopUpdateController.IsAction((string)action)) return;
                if ((string)action == "status") PublishUpdateState(updater.State);
                else if ((string)action == "check") { await updater.CheckAsync(); PublishUpdateState(updater.State); }
                else if ((string)action == "restart" && updater.CanRestart) await RestartForUpdateAsync();
            }
            catch (Exception error) { Log("The updater message could not be handled: " + error.Message); }
        }

        private void PublishUpdateState(DesktopUpdateState state)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            if (InvokeRequired) { try { BeginInvoke(new Action<DesktopUpdateState>(PublishUpdateState), state); } catch (InvalidOperationException) { } return; }
            try
            {
                if (web != null && web.CoreWebView2 != null && IsLocalPage(web.CoreWebView2.Source)) web.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(state));
            }
            catch (InvalidOperationException) { }
            catch (COMException) { }
        }

        private async Task RestartForUpdateAsync()
        {
            if (closing || !updater.CanRestart) return;
            if (!hostOwnsServer)
            {
                MessageBox.Show("A separately opened browser player is sharing this connection. Close that player and stop its server, then reopen Charliflix before installing the update.", "Charliflix update", MessageBoxButtons.OK, MessageBoxIcon.Information);
                PublishUpdateState(updater.State);
                return;
            }
            closing = true;
            updateTimer.Stop();
            Hide();
            bool applied = await updater.RestartAsync(delegate { return ShutdownPlayerAsync(true); });
            if (!applied) MessageBox.Show("Charliflix could not install the downloaded update. Open the app and try again.", "Charliflix update", MessageBoxButtons.OK, MessageBoxIcon.Information);
            updater.Dispose();
            updateTimer.Dispose();
            closeComplete = true;
            Close();
        }

        private static bool IsReleasePage(string address)
        {
            return address != null && Regex.IsMatch(address,
                @"\Ahttps://github\.com/charlesmbeckwith/charliflix/releases/(?:latest|tag/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\z",
                RegexOptions.CultureInvariant);
        }

        private void OnHostMessage(object sender, DataReceivedEventArgs e)
        {
            if (String.IsNullOrEmpty(e.Data)) return;
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(e.Data);
                string type = Convert.ToString(data["type"]);
                if (type == "ready")
                {
                    string url = Convert.ToString(data["url"]);
                    if (url != "http://127.0.0.1:8767") throw new InvalidOperationException("The local player returned an unexpected address.");
                    if (Convert.ToString(data["version"]) != Program.Version || !String.Equals(Path.GetFullPath(Convert.ToString(data["directory"])).TrimEnd(Path.DirectorySeparatorChar), Program.Root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetFullPath(Convert.ToString(data["runtimeDirectory"])).TrimEnd(Path.DirectorySeparatorChar), Program.RuntimeDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("A different version or installation is already using the local player connection. Close the other player and open Charliflix again.");
                    hostOwnsServer = data.ContainsKey("ownsServer") && data["ownsServer"] is bool && (bool)data["ownsServer"];
                    ready.TrySetResult(url);
                }
                else if (type == "error") ready.TrySetException(new InvalidOperationException(Convert.ToString(data["message"])));
                else if (type == "cleanup-error") { hostCleanupFailed = true; Log(e.Data); }
                else if (type == "closed") { hostCleanupConfirmed = data.ContainsKey("success") && data["success"] is bool && (bool)data["success"] && data.ContainsKey("stopped") && data["stopped"] is bool && (bool)data["stopped"] && data.ContainsKey("ownsServer") && data["ownsServer"] is bool && (bool)data["ownsServer"]; }
                else Log(e.Data);
            }
            catch (Exception error) { ready.TrySetException(new InvalidOperationException("The local player could not be initialized.", error)); }
        }

        private void ShowFailure(string message)
        {
            if (web != null) web.Visible = false;
            notice.Text = message;
            notice.Visible = true;
            notice.BringToFront();
        }

        private void SetFullscreen(bool enabled)
        {
            if (fullscreen == enabled) return;
            fullscreen = enabled;
            if (enabled)
            {
                previousState = WindowState;
                previousBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = previousBounds;
                WindowState = previousState;
            }
        }

        private async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (closeComplete) return;
            e.Cancel = true;
            if (closing) return;
            closing = true;
            updater.Dispose();
            updateTimer.Stop();
            updateTimer.Dispose();
            Hide();
            await ShutdownPlayerAsync();
            closeComplete = true;
            Close();
        }

        private async Task ShutdownPlayerAsync(bool requireStopped = false)
        {
            if (web != null) { web.Dispose(); web = null; }
            if (host != null)
            {
                bool exited = false;
                bool successfulExit = false;
                try
                {
                    if (!host.HasExited) { host.StandardInput.WriteLine("close"); host.StandardInput.Close(); }
                    exited = await Task.Run(() => {
                        if (!host.WaitForExit(16000)) return false;
                        // Flush asynchronous stdout so a cleanup-error cannot be missed.
                        host.WaitForExit();
                        return true;
                    });
                    successfulExit = exited && host.ExitCode == 0;
                    if (!exited && !requireStopped && !host.HasExited) host.Kill();
                }
                catch (InvalidOperationException) { }
                catch (IOException error) { Log(error.Message); }
                catch (System.ComponentModel.Win32Exception error) { Log(error.Message); }
                finally { host.Dispose(); host = null; }
                if (requireStopped && (!successfulExit || hostCleanupFailed || !hostCleanupConfirmed)) throw new InvalidOperationException("The local streaming backend did not finish closing. The update was not started.");
            }
        }

        private static void Log(string message)
        {
            try { string folder = Program.RuntimeDirectory; Directory.CreateDirectory(folder); File.AppendAllText(Path.Combine(folder, "desktop.log"), DateTime.UtcNow.ToString("u") + " " + message + Environment.NewLine); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
