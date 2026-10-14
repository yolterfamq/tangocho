using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Tangocho;

public partial class MainWindow : Window
{
    const string Host = "tangocho.app";

    readonly Settings _settings = Settings.Load();
    readonly bool _justUpdated;

    ReleaseInfo? _release;        // найденный новый релиз
    bool _busy;                    // идёт проверка/скачивание
    bool _webReady;

    public MainWindow(bool justUpdated)
    {
        _justUpdated = justUpdated;
        InitializeComponent();
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x0C, 0x0E, 0x12);

        Width = _settings.Width;
        Height = _settings.Height;
        if (_settings.Left is double l && _settings.Top is double t && IsOnScreen(l, t))
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = l; Top = t;
        }
        if (_settings.Maximized) WindowState = WindowState.Maximized;

        Loaded += async (_, _) => await InitWebAsync();
        Closing += (_, _) => OnClosing();
    }

    static bool IsOnScreen(double l, double t) =>
        l > SystemParameters.VirtualScreenLeft - 50 && t > SystemParameters.VirtualScreenTop - 20 &&
        l < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 100 &&
        t < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 100;

    public void BringToFront()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true; Topmost = false;
        Focus();
    }

    // ───────────── WebView ─────────────

    async Task InitWebAsync()
    {
        try
        {
            ExtractWeb();
            var env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData);
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            NoRuntime.Visibility = Visibility.Visible;
            return;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Не удалось запустить окно карточек:\n" + ex.Message, "Тангочо",
                MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        var core = Web.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(Host, Paths.Web, CoreWebView2HostResourceAccessKind.Allow);
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;

        // Внешние ссылки — в обычный браузер
        core.NewWindowRequested += (_, a) => { a.Handled = true; OpenUrl(a.Uri); };
        core.NavigationStarting += (_, a) =>
        {
            if (!a.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase))
            {
                a.Cancel = true;
                OpenUrl(a.Uri);
            }
        };

        core.WebMessageReceived += OnWebMessage;
        Web.Source = new Uri($"https://{Host}/index.html");
    }

    /// Кладём страницу из exe в %LocalAppData%\Tangocho\web (каждый запуск — свежая версия)
    static void ExtractWeb()
    {
        Directory.CreateDirectory(Paths.Web);
        var asm = Assembly.GetExecutingAssembly();
        int n = 0;
        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith("web/")) continue;
            using var res = asm.GetManifestResourceStream(name)!;
            using var file = File.Create(Path.Combine(Paths.Web, name[4..]));
            res.CopyTo(file);
            n++;
        }
        if (n == 0) throw new InvalidOperationException("Нет встроенной страницы");
    }

    static void OpenUrl(string url)
    {
        if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    void GetRuntime_Click(object sender, RoutedEventArgs e) =>
        OpenUrl("https://developer.microsoft.com/microsoft-edge/webview2/");

    // ───────────── Мост страница ↔ приложение ─────────────

    void Send(object msg)
    {
        if (!_webReady) return;
        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(msg));
    }

    void SendStatus(string state, string? message = null, double? progress = null)
    {
        Send(new
        {
            type = "status",
            state,
            message,
            progress,
            version = _release?.Version.ToString() ?? Updater.PendingVersion()?.ToString(),
            notes = _release?.Notes
        });
    }

    async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string type;
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            root = doc.RootElement.Clone();
            type = root.GetProperty("type").GetString() ?? "";
        }
        catch { return; }

        switch (type)
        {
            case "ready":
                _webReady = true;
                Send(new
                {
                    type = "info",
                    version = Updater.CurrentVersion.ToString(),
                    enabled = Updater.Enabled,
                    repo = Updater.Repo,
                    auto = _settings.AutoUpdate,
                    justUpdated = _justUpdated
                });
                if (Updater.PendingVersion() != null) SendStatus("ready");
                else if (Updater.Enabled && _settings.AutoUpdate) await CheckAsync(autoDownload: true, silent: true);
                else SendStatus("idle");
                break;

            case "check":
                await CheckAsync(autoDownload: false, silent: false);
                break;

            case "download":
                await DownloadAsync();
                break;

            case "install":
                if (Updater.Apply(restart: true)) { _skipApplyOnClose = true; Close(); }
                else SendStatus("error", "Не удалось заменить файл программы. Закрой Тангочо и запусти снова.");
                break;

            case "auto":
                _settings.AutoUpdate = root.TryGetProperty("value", out var v) && v.GetBoolean();
                _settings.Save();
                break;

            case "theme":
                SetDarkTitleBar(root.TryGetProperty("dark", out var d) && d.GetBoolean());
                break;

            case "open":
                if (root.TryGetProperty("url", out var u)) OpenUrl(u.GetString() ?? "");
                break;

            case "googleLogin":
                if (root.TryGetProperty("url", out var au)) _ = GoogleLoginAsync(au.GetString() ?? "");
                break;
        }
    }

    // ───────────── Вход через Google в обычном браузере ─────────────
    // Google не разрешает входить во встроенном окне, поэтому открываем браузер,
    // а страница входа возвращает токен на локальный адрес 127.0.0.1, который слушает программа.

    System.Net.Sockets.TcpListener? _loginListener;

    async Task GoogleLoginAsync(string authPage)
    {
        try { _loginListener?.Stop(); } catch { }
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        _loginListener = listener;
        try
        {
            listener.Start();
            int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            OpenUrl(authPage + "?return=" + Uri.EscapeDataString($"http://127.0.0.1:{port}/cb"));

            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(5));
            var result = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var reg = cts.Token.Register(() => result.TrySetCanceled());

            // Браузер может открыть несколько соединений (в т.ч. пустых) — обслуживаем каждое отдельно
            _ = Task.Run(async () =>
            {
                while (!result.Task.IsCompleted)
                {
                    System.Net.Sockets.TcpClient client;
                    try { client = await listener.AcceptTcpClientAsync(cts.Token); }
                    catch { break; }
                    _ = Task.Run(() => HandleLoginClient(client, result));
                }
            });

            var token = await result.Task;      // ждём на UI-потоке
            Send(new { type = "googleToken", idToken = token });
            BringToFront();
        }
        catch (OperationCanceledException)
        {
            if (_loginListener == listener)
                Send(new { type = "googleError", message = "Время на вход вышло. Нажми «Войти через Google» ещё раз." });
        }
        catch (Exception ex)
        {
            if (_loginListener == listener)
                Send(new { type = "googleError", message = "Не удалось войти: " + ex.Message });
        }
        finally
        {
            try { listener.Stop(); } catch { }
        }
    }

    static async Task HandleLoginClient(System.Net.Sockets.TcpClient client, TaskCompletionSource<string> result)
    {
        using (client)
        {
            try
            {
                using var stream = client.GetStream();
                using var readCts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var buf = new byte[16384];
                int read = await stream.ReadAsync(buf, readCts.Token);
                if (read <= 0) return;
                var line = System.Text.Encoding.UTF8.GetString(buf, 0, read).Split("\r\n")[0];   // GET /cb?idToken=... HTTP/1.1
                var parts = line.Split(' ');
                if (parts.Length < 2 || !parts[1].StartsWith("/cb")) { await Reply(stream, 404, "Not found"); return; }

                var target = parts[1];
                var query = target.Contains('?') ? target[(target.IndexOf('?') + 1)..] : "";
                string? token = null;
                foreach (var kv in query.Split('&'))
                {
                    var i = kv.IndexOf('=');
                    if (i > 0 && kv[..i] == "idToken") token = Uri.UnescapeDataString(kv[(i + 1)..]);
                }
                await Reply(stream, 200,
                    "<!doctype html><meta charset=utf-8><title>Тангочо</title>" +
                    "<body style=\"font:18px system-ui;background:#0c0e12;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0\">" +
                    "<div style=\"text-align:center\"><div style=\"font-size:44px;color:#9db1ea\">単</div>" +
                    (token != null ? "Готово! Можно закрыть вкладку и вернуться в Тангочо." : "Вход не удался. Попробуй ещё раз.") + "</div>");

                if (token != null) result.TrySetResult(token);
                else result.TrySetException(new Exception("Google не вернул данные входа."));
            }
            catch { /* пустое или оборванное соединение — игнорируем */ }
        }
    }

    static async Task Reply(System.Net.Sockets.NetworkStream stream, int code, string html)
    {
        var body = System.Text.Encoding.UTF8.GetBytes(html);
        var head = System.Text.Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {code} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(head);
        await stream.WriteAsync(body);
    }

    // ───────────── Обновления ─────────────

    async Task CheckAsync(bool autoDownload, bool silent)
    {
        if (_busy) return;
        if (!Updater.Enabled) { SendStatus("disabled"); return; }
        if (Updater.PendingVersion() != null) { SendStatus("ready"); return; }

        _busy = true;
        if (!silent) SendStatus("checking");
        try
        {
            _release = await Updater.CheckAsync();
            _busy = false;
            if (_release == null) { SendStatus("latest"); return; }
            SendStatus("available");
            if (autoDownload) await DownloadAsync();
        }
        catch (Exception ex)
        {
            _busy = false;
            SendStatus(silent ? "idle" : "error", silent ? null : "Не удалось проверить обновления. Проверь интернет. (" + ex.Message + ")");
        }
    }

    async Task DownloadAsync()
    {
        if (_busy || _release == null) return;
        _busy = true;
        SendStatus("downloading", progress: 0);
        try
        {
            await Updater.DownloadAsync(_release, new Progress<double>(p => SendStatus("downloading", progress: p)));
            SendStatus("ready");
        }
        catch (Exception ex)
        {
            SendStatus("error", "Не удалось скачать обновление: " + ex.Message);
        }
        finally { _busy = false; }
    }

    bool _skipApplyOnClose;

    void OnClosing()
    {
        // Запоминаем окно
        _settings.Maximized = WindowState == WindowState.Maximized;
        var b = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (b.Width > 0) { _settings.Left = b.Left; _settings.Top = b.Top; _settings.Width = b.Width; _settings.Height = b.Height; }
        _settings.Save();

        // Скачанное обновление ставится при закрытии — в следующий раз откроется новая версия
        if (!_skipApplyOnClose) Updater.Apply(restart: false);
    }

    // ───────────── Тёмный заголовок окна ─────────────

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    void SetDarkTitleBar(bool dark)
    {
        try
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            int v = dark ? 1 : 0;
            if (DwmSetWindowAttribute(hwnd, 20, ref v, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref v, sizeof(int)); // старые сборки Windows 10
            byte r = dark ? (byte)0x0C : (byte)0xF2, g = dark ? (byte)0x0E : (byte)0xF3, b = dark ? (byte)0x12 : (byte)0xF6;
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(r, g, b));
            Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(r, g, b);
        }
        catch { }
    }
}
