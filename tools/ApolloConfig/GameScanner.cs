using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ApolloConfig;

/// <summary>Um jogo encontrado, já no formato aceito por /api/apps do Apollo.</summary>
internal sealed record Game(string Source, string Id, string Name, string? Cmd, string? Detached, string? WorkingDir) {
  public string Uuid {
    get {
      var h = MD5.HashData(Encoding.UTF8.GetBytes($"r3dcore:{Source}:{Id}"));
      return new Guid(h).ToString().ToUpperInvariant();
    }
  }

  public JsonObject ToApp() {
    var o = new JsonObject { ["name"] = Name, ["uuid"] = Uuid, ["image-path"] = "" };
    if (Cmd != null) o["cmd"] = Cmd;
    if (WorkingDir != null) o["working-dir"] = WorkingDir;
    if (Detached != null) o["detached"] = new JsonArray(Detached);
    return o;
  }
}

/// <summary>Detecta jogos instalados nos launchers mais comuns do Windows.</summary>
internal static class GameScanner {
  private static readonly string[] SteamIgnore = { "Steamworks Common Redistributables", "Steam Linux Runtime", "Proton", "Steamworks Shared" };

  public static List<Game> ScanAll() {
    var all = new List<Game>();
    foreach (var scan in new Func<IEnumerable<Game>>[] { Steam, Epic, Gog, Ubisoft }) {
      try { all.AddRange(scan()); } catch { /* um launcher com problema não derruba os demais */ }
    }
    return all.GroupBy(g => g.Uuid).Select(g => g.First()).OrderBy(g => g.Name).ToList();
  }

  private static IEnumerable<Game> Steam() {
    var root = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string;
    if (root == null) yield break;
    var libs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { root.Replace('/', '\\') };
    var vdf = Path.Combine(root, "steamapps", "libraryfolders.vdf");
    if (File.Exists(vdf)) {
      foreach (Match m in Regex.Matches(File.ReadAllText(vdf), @"""path""\s+""([^""]+)""")) {
        libs.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
      }
    }
    foreach (var lib in libs) {
      var dir = Path.Combine(lib, "steamapps");
      if (!Directory.Exists(dir)) continue;
      foreach (var acf in Directory.EnumerateFiles(dir, "appmanifest_*.acf")) {
        var text = File.ReadAllText(acf);
        var id = Regex.Match(text, @"""appid""\s+""(\d+)""").Groups[1].Value;
        var name = Regex.Match(text, @"""name""\s+""([^""]+)""").Groups[1].Value;
        if (id == "" || name == "" || SteamIgnore.Any(i => name.StartsWith(i, StringComparison.OrdinalIgnoreCase))) continue;
        yield return new Game("steam", id, name, null, $"steam://rungameid/{id}", null);
      }
    }
  }

  private static IEnumerable<Game> Epic() {
    var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Epic", "EpicGamesLauncher", "Data", "Manifests");
    if (!Directory.Exists(dir)) yield break;
    foreach (var f in Directory.EnumerateFiles(dir, "*.item")) {
      var j = JsonNode.Parse(File.ReadAllText(f));
      if (j == null || j["bIsIncompleteInstall"]?.GetValue<bool>() == true) continue;
      var name = j["DisplayName"]?.GetValue<string>();
      var app = j["AppName"]?.GetValue<string>();
      var ns = j["CatalogNamespace"]?.GetValue<string>();
      var item = j["CatalogItemId"]?.GetValue<string>();
      var exe = j["LaunchExecutable"]?.GetValue<string>();
      if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(app) || string.IsNullOrEmpty(exe)) continue;
      yield return new Game("epic", app, name, null, $"com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true", null);
    }
  }

  private static IEnumerable<Game> Gog() {
    using var games = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\GOG.com\Games");
    if (games == null) yield break;
    foreach (var id in games.GetSubKeyNames()) {
      using var k = games.OpenSubKey(id);
      var name = k?.GetValue("gameName") as string;
      var exe = k?.GetValue("exe") as string;
      var path = k?.GetValue("path") as string;
      if (name == null || exe == null || !File.Exists(exe)) continue;
      yield return new Game("gog", id, name, $"\"{exe}\"", null, path ?? Path.GetDirectoryName(exe));
    }
  }

  private static IEnumerable<Game> Ubisoft() {
    using var installs = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs");
    if (installs == null) yield break;
    foreach (var id in installs.GetSubKeyNames()) {
      using var k = installs.OpenSubKey(id);
      var dir = (k?.GetValue("InstallDir") as string)?.TrimEnd('/', '\\');
      if (dir == null || !Directory.Exists(dir)) continue;
      yield return new Game("ubisoft", id, Path.GetFileName(dir), null, $"uplay://launch/{id}/0", null);
    }
  }
}
