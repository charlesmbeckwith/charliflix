using System;
using System.Text.RegularExpressions;

namespace ChannelRoomDesktop
{
    internal static class DesktopExternalNavigation
    {
        internal static bool IsReleasePage(string address)
        {
            return address != null && Regex.IsMatch(address,
                @"\Ahttps://github\.com/charlesmbeckwith/charliflix/releases/(?:latest|tag/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\z",
                RegexOptions.CultureInvariant);
        }

        internal static bool IsAllowedPage(string address)
        {
            return IsReleasePage(address) || String.Equals(address, "https://epgtalk.com/api.html", StringComparison.Ordinal);
        }
    }
}
