using System.Diagnostics;
using Microsoft.Win32;

namespace ApolloConfig;

/// <summary>Reconhece o motor de um jogo pela pasta de instalação, para saber quais argumentos de resolução ele aceita.</summary>
internal static class EngineDetector {
  public static string? Detect(string dir) {
    try {
      if (!Directory.Exists(dir)) return null;
      if (File.Exists(Path.Combine(dir, "UnityPlayer.dll"))) return "unity";
      if (Directory.EnumerateFiles(dir, "*.pck", SearchOption.TopDirectoryOnly).Any()) return "godot";
      // Unreal: executável "*-Win64-Shipping.exe" (em Binaries\Win64) ou pasta Engine\Binaries
      if (Directory.Exists(Path.Combine(dir, "Engine", "Binaries"))) return "unreal";
      foreach (var sub in Directory.EnumerateDirectories(dir)) {
        var bin = Path.Combine(sub, "Binaries", "Win64");
        if (Directory.Exists(bin) && Directory.EnumerateFiles(bin, "*-Win64-Shipping.exe", SearchOption.TopDirectoryOnly).Any()) return "unreal";
      }
      // Source (Valve): cada mod/jogo tem um gameinfo.txt dentro de uma subpasta
      foreach (var sub in Directory.EnumerateDirectories(dir)) {
        if (File.Exists(Path.Combine(sub, "gameinfo.txt"))) return "source";
      }
    } catch { /* pasta inacessível ou sem esses diretórios: motor desconhecido */ }
    return null;
  }

  /// <summary>Argumentos que fazem o jogo abrir sem bordas na resolução [w]x[h] (a mesma da tela virtual).</summary>
  public static string? Args(string engine, int w, int h) => engine switch {
    "source" => $"-w {w} -h {h} -windowed -noborder",
    "unity" => $"-screen-width {w} -screen-height {h} -screen-fullscreen 0 -popupwindow",
    "unreal" => $"-windowed -ResX={w} -ResY={h}",
    "godot" => $"--resolution {w}x{h} --fullscreen",
    _ => null,
  };
}

/// <summary>Abre um jogo da Steam passando a resolução do celular (variáveis APOLLO_CLIENT_WIDTH/HEIGHT do Apollo).</summary>
internal static class SteamLauncher {
  private static int Env(string name) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : 0;

  public static int Launch(string appId, string engine) {
    var w = Env("APOLLO_CLIENT_WIDTH");
    var h = Env("APOLLO_CLIENT_HEIGHT");
    if (w == 0 || h == 0) { w = Env("SUNSHINE_CLIENT_WIDTH"); h = Env("SUNSHINE_CLIENT_HEIGHT"); }
    var args = w > 0 && h > 0 ? EngineDetector.Args(engine, w, h) : null;
    var steam = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamExe", null) as string;
    try {
      if (args != null && steam != null && File.Exists(steam)) {
        Process.Start(new ProcessStartInfo(steam, $"-applaunch {appId} {args}") { UseShellExecute = false, CreateNoWindow = true });
      } else {
        Process.Start(new ProcessStartInfo($"steam://rungameid/{appId}") { UseShellExecute = true });
      }
      return 0;
    } catch {
      return 1;
    }
  }
}
