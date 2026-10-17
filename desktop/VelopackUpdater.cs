using System;
using System.Threading;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace ChannelRoomDesktop
{
    internal sealed class VelopackUpdateBackend : IDesktopUpdateBackend
    {
        private readonly UpdateManager manager;
        private readonly string currentVersion;
        private UpdateInfo pending;
        private bool downloaded;

        internal VelopackUpdateBackend(string fallbackVersion)
        {
            currentVersion = fallbackVersion;
            // Public releases need no token. The publisher and stable feed are fixed in native code.
            manager = new UpdateManager(new GithubSource("https://github.com/charlesmbeckwith/charliflix", null, false));
        }

        // Legacy extracted ZIPs and developer checkouts have no Velopack installation.
        public bool IsInstalled { get { return manager.IsInstalled && manager.AppId == "Charliflix"; } }
        public string CurrentVersion { get { return manager.CurrentVersion == null ? currentVersion : manager.CurrentVersion.ToString(); } }

        public async Task<string> CheckAsync()
        {
            if (!IsInstalled) return null;
            pending = await manager.CheckForUpdatesAsync();
            downloaded = false;
            return pending == null ? null : pending.TargetFullRelease.Version.ToString();
        }

        public async Task DownloadAsync(Action<int> progress, CancellationToken cancellationToken)
        {
            if (!IsInstalled || pending == null) throw new InvalidOperationException("There is no managed update to download.");
            await manager.DownloadUpdatesAsync(pending, progress, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            downloaded = true;
        }

        public void ApplyAndRestart()
        {
            if (!IsInstalled || pending == null || !downloaded) throw new InvalidOperationException("The update has not been verified and downloaded.");
            manager.ApplyUpdatesAndRestart(pending);
        }
    }
}
