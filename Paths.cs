using System.IO;

namespace Tangocho;

static class Paths
{
    /// %LocalAppData%\Tangocho — данные приложения (прогресс, настройки, загрузки)
    public static readonly string Data =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tangocho");

    /// %LocalAppData%\Programs\Tangocho — куда ставится сам exe
    public static readonly string InstallDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Tangocho");

    public static string InstalledExe => Path.Combine(InstallDir, "Tangocho.exe");

    public static string CurrentExe => Environment.ProcessPath ?? InstalledExe;

    public static string Web => Path.Combine(Data, "web");
    public static string WebViewData => Path.Combine(Data, "WebView2");
    public static string Downloads => Path.Combine(Data, "update");
    public static string Settings => Path.Combine(Data, "settings.json");
}
