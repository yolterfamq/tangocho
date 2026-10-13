using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;

namespace Tangocho;

record ReleaseInfo(Version Version, string Tag, string Notes, string DownloadUrl, long Size);

/// Обновления через GitHub Releases.
/// 1) смотрим последний релиз репозитория;
/// 2) если версия новее — качаем Tangocho.exe во временную папку;
/// 3) подменяем exe: запущенный файл переименовываем в .old (Windows это разрешает),
///    новый кладём на его место и перезапускаемся.
static class Updater
{
    public const string AssetName = "Tangocho.exe";

    public static Version CurrentVersion
    {
        get
        {
            var v = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(1, 0, 0);
            return new Version(v.Major, v.Minor, Math.Max(v.Build, 0));
        }
    }

    public static string Repo =>
        Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "UpdateRepo")?.Value ?? "";

    public static bool Enabled => Repo.Contains('/');

    static readonly HttpClient Http = CreateClient();

    static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Tangocho-Updater");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    public static string NewExePath => Path.Combine(Paths.Downloads, "Tangocho.new.exe");

    /// Возвращает релиз, если он новее текущей версии, иначе null.
    public static async Task<ReleaseInfo?> CheckAsync(CancellationToken ct = default)
    {
        if (!Enabled) return null;

        var json = await Http.GetStringAsync($"https://api.github.com/repos/{Repo}/releases/latest", ct);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var remote)) return null;
        remote = new Version(remote.Major, remote.Minor, Math.Max(remote.Build, 0));

        string url = ""; long size = 0;
        foreach (var a in root.GetProperty("assets").EnumerateArray())
        {
            if (string.Equals(a.GetProperty("name").GetString(), AssetName, StringComparison.OrdinalIgnoreCase))
            {
                url = a.GetProperty("browser_download_url").GetString() ?? "";
                size = a.GetProperty("size").GetInt64();
            }
        }
        if (url == "") return null;

        var notes = root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
        return remote > CurrentVersion ? new ReleaseInfo(remote, tag, notes, url, size) : null;
    }

    /// Качает exe релиза. progress: 0..1
    public static async Task DownloadAsync(ReleaseInfo rel, IProgress<double> progress, CancellationToken ct = default)
    {
        Directory.CreateDirectory(Paths.Downloads);
        var tmp = NewExePath + ".part";

        using (var resp = await Http.GetAsync(rel.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? rel.Size;
            await using var src = await resp.Content.ReadAsStreamAsync(ct);
            await using var dst = File.Create(tmp);
            var buf = new byte[81920];
            long read = 0; int n; double last = -1;
            while ((n = await src.ReadAsync(buf, ct)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n), ct);
                read += n;
                if (total > 0)
                {
                    var p = (double)read / total;
                    if (p - last >= 0.01) { last = p; progress.Report(p); }
                }
            }
            if (total > 0 && read != total) throw new IOException("Файл скачался не полностью");
        }

        File.Move(tmp, NewExePath, true);
        File.WriteAllText(NewExePath + ".ver", rel.Version.ToString());
        progress.Report(1);
    }

    /// Готовое скачанное обновление (если есть и оно новее текущей версии)
    public static Version? PendingVersion()
    {
        try
        {
            if (!File.Exists(NewExePath) || !File.Exists(NewExePath + ".ver")) return null;
            var v = Version.Parse(File.ReadAllText(NewExePath + ".ver").Trim());
            if (v > CurrentVersion) return v;
            File.Delete(NewExePath);
            File.Delete(NewExePath + ".ver");
        }
        catch { }
        return null;
    }

    /// Подменяет exe на скачанный. restart = запустить новую версию сразу.
    public static bool Apply(bool restart)
    {
        if (PendingVersion() == null) return false;
        var exe = Paths.CurrentExe;
        var old = exe + ".old";
        try
        {
            if (File.Exists(old)) File.Delete(old);
        }
        catch { }

        try
        {
            File.Move(exe, old);
            File.Move(NewExePath, exe);
            try { File.Delete(NewExePath + ".ver"); } catch { }
        }
        catch
        {
            // Откат, если что-то пошло не так
            try { if (!File.Exists(exe) && File.Exists(old)) File.Move(old, exe); } catch { }
            return false;
        }

        if (restart)
        {
            Process.Start(new ProcessStartInfo(exe, "--updated")
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(exe)!
            });
        }
        return true;
    }

    /// Удаляет Tangocho.exe.old, оставшийся после обновления
    public static void CleanupOld()
    {
        var old = Paths.CurrentExe + ".old";
        for (int i = 0; i < 10 && File.Exists(old); i++)
        {
            try { File.Delete(old); }
            catch { Thread.Sleep(300); } // старый процесс ещё закрывается
        }
    }
}
