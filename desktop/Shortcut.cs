using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace ChannelRoomDesktop
{
    /// <summary>Creates an explicitly requested shortcut without changing taskbar pins.</summary>
    public static class ShortcutInstaller
    {
        private static readonly PropertyKey AppUserModelId = new PropertyKey(
            new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

        public static string Create(string exePath, string outputPath, string appId)
        {
            if (String.IsNullOrWhiteSpace(exePath)) throw new ArgumentException("An executable path is required.", "exePath");
            if (String.IsNullOrWhiteSpace(outputPath)) throw new ArgumentException("A shortcut path is required.", "outputPath");
            if (String.IsNullOrWhiteSpace(appId) || appId.Length > 128 || appId.IndexOf('\0') >= 0)
                throw new ArgumentException("The application ID must contain 1 to 128 characters.", "appId");

            exePath = Path.GetFullPath(exePath);
            outputPath = Path.GetFullPath(outputPath);
            if (!File.Exists(exePath)) throw new FileNotFoundException("The Channel Room executable was not found.", exePath);
            if (!String.Equals(Path.GetExtension(outputPath), ".lnk", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("The shortcut path must end in .lnk.", "outputPath");
            if (!Directory.Exists(Path.GetDirectoryName(outputPath)))
                throw new DirectoryNotFoundException("The shortcut's destination folder does not exist.");
            if (File.Exists(outputPath) || Directory.Exists(outputPath))
                throw new IOException("A file or folder already exists at the requested shortcut path. It was not replaced.");

            string temporaryPath = outputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            object linkObject = null;
            PropVariant applicationId = new PropVariant();
            try
            {
                linkObject = new ShellLink();
                IShellLinkW link = (IShellLinkW)linkObject;
                link.SetPath(exePath);
                link.SetWorkingDirectory(Path.GetDirectoryName(exePath));
                link.SetDescription("Channel Room");
                link.SetIconLocation(exePath, 0);
                link.SetShowCmd(1);

                IPropertyStore properties = (IPropertyStore)linkObject;
                PropertyKey key = AppUserModelId;
                applicationId = PropVariant.FromString(appId);
                Marshal.ThrowExceptionForHR(properties.SetValue(ref key, ref applicationId));
                Marshal.ThrowExceptionForHR(properties.Commit());

                IPersistFile file = (IPersistFile)linkObject;
                file.Save(temporaryPath, true);
                // File.Move refuses to replace an existing destination, including one
                // created after the earlier existence check.
                File.Move(temporaryPath, outputPath);
                return outputPath;
            }
            finally
            {
                applicationId.Dispose();
                if (linkObject != null && Marshal.IsComObject(linkObject))
                    Marshal.FinalReleaseComObject(linkObject);
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
        }

        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink { }

        [ComImport]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int maximumLength, IntPtr findData, uint flags);
            void GetIDList(out IntPtr itemIdList);
            void SetIDList(IntPtr itemIdList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int maximumLength);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maximumLength);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maximumLength);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out short hotkey);
            void SetHotkey(short hotkey);
            void GetShowCmd(out int showCommand);
            void SetShowCmd(int showCommand);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maximumLength, out int iconIndex);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct PropertyKey
        {
            public Guid FormatId;
            public uint PropertyId;

            public PropertyKey(Guid formatId, uint propertyId)
            {
                FormatId = formatId;
                PropertyId = propertyId;
            }
        }

        [ComImport]
        [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint propertyCount);
            [PreserveSig] int GetAt(uint propertyIndex, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CountedArray
        {
            public uint Count;
            public IntPtr Elements;
        }

        // The counted-array member gives the native PROPVARIANT union its
        // architecture-dependent size: 24 bytes on x64 and 16 bytes on x86.
        [StructLayout(LayoutKind.Explicit)]
        private struct PropVariant : IDisposable
        {
            [FieldOffset(0)] private ushort valueType;
            [FieldOffset(2)] private ushort reserved1;
            [FieldOffset(4)] private ushort reserved2;
            [FieldOffset(6)] private ushort reserved3;
            [FieldOffset(8)] private IntPtr stringValue;
            [FieldOffset(8)] private CountedArray arrayValue;

            public static PropVariant FromString(string value)
            {
                PropVariant variant = new PropVariant();
                variant.stringValue = Marshal.StringToCoTaskMemUni(value);
                variant.valueType = 31; // VT_LPWSTR
                return variant;
            }

            public void Dispose()
            {
                PropVariantClear(ref this);
            }

            [DllImport("ole32.dll")]
            private static extern int PropVariantClear(ref PropVariant value);
        }
    }
}
