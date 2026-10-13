using System.IO;
using System.Text.Json;

namespace Tangocho;

class Settings
{
    public bool AutoUpdate { get; set; } = true;
    public double Width { get; set; } = 520;
    public double Height { get; set; } = 820;
    public double? Left { get; set; }
    public double? Top { get; set; }
    public bool Maximized { get; set; }

    public static Settings Load()
    {
        try
        {
            if (File.Exists(Paths.Settings))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(Paths.Settings)) ?? new();
        }
        catch { }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Paths.Data);
            File.WriteAllText(Paths.Settings, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }
}
