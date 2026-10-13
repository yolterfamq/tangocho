using System.Diagnostics;
using System.IO;

namespace Tangocho;

/// Первый запуск: копирует exe в %LocalAppData%\Programs\Tangocho,
/// создаёт ярлыки в «Пуске» и на рабочем столе и перезапускается оттуда.
/// Так обновления всегда могут перезаписать exe без прав администратора.
static class Installer
{
    public static bool InstallIfNeeded(string[] args)
    {
        try
        {
            var current = Path.GetFullPath(Paths.CurrentExe);
            var target = Path.GetFullPath(Paths.InstalledExe);

            if (args.Contains("--portable")) return false;
            if (string.Equals(current, target, StringComparison.OrdinalIgnoreCase)) return false;
            if (!current.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return false; // запуск из IDE

            Directory.CreateDirectory(Paths.InstallDir);

            // Если уже установлена другая версия — она может быть запущена; переименуем её
            if (File.Exists(target))
            {
                try { File.Move(target, target + ".old", true); } catch { }
            }
            File.Copy(current, target, true);

            CreateShortcuts(target);

            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = Paths.InstallDir });
            return true;
        }
        catch
        {
            // Не получилось — просто работаем из текущей папки
            return false;
        }
    }

    public static void CreateShortcuts(string exe)
    {
        var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Тангочо.lnk");
        var desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Тангочо.lnk");
        CreateShortcut(startMenu, exe);
        if (!File.Exists(desktop)) CreateShortcut(desktop, exe);
    }

    static void CreateShortcut(string lnkPath, string exe)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = exe;
            lnk.WorkingDirectory = Path.GetDirectoryName(exe);
            lnk.IconLocation = exe + ",0";
            lnk.Description = "Тангочо — японские карточки";
            lnk.Save();
        }
        catch { }
    }
}
