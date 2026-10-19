using System.Diagnostics;

namespace ApolloConfig;

/// <summary>Fecha os processos de um jogo identificando-os pela pasta de instalação. Primeiro pede para fechar a janela;
/// o que não sair em alguns segundos é encerrado. Nunca mexe em processos fora da pasta (Steam, launchers, sistema).</summary>
internal static class GameCloser {
  public static int CloseProcessesIn(string dir) {
    string root;
    try { root = Path.GetFullPath(dir).TrimEnd('\\', '/') + Path.DirectorySeparatorChar; } catch { return 2; }

    // Trava de segurança: a pasta precisa ser de um jogo (pelo menos 3 níveis) e não pode estar dentro do Windows.
    var depth = root.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries).Length;
    var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\') + Path.DirectorySeparatorChar;
    if (depth < 3 || root.StartsWith(windows, StringComparison.OrdinalIgnoreCase)) return 2;

    var targets = new List<Process>();
    foreach (var p in Process.GetProcesses()) {
      try {
        var exe = p.MainModule?.FileName;
        if (exe != null && exe.StartsWith(root, StringComparison.OrdinalIgnoreCase) && p.Id != Environment.ProcessId) targets.Add(p);
      } catch { /* sem acesso (processo do sistema): não é do jogo */ }
    }
    foreach (var p in targets) { try { p.CloseMainWindow(); } catch { } }
    var deadline = DateTime.UtcNow.AddSeconds(6);
    while (DateTime.UtcNow < deadline && targets.Any(p => !SafeExited(p))) Thread.Sleep(250);
    foreach (var p in targets.Where(p => !SafeExited(p))) { try { p.Kill(true); } catch { } }
    return 0;
  }

  private static bool SafeExited(Process p) { try { return p.HasExited; } catch { return true; } }
}
