using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ApolloConfig;

/// <summary>Um .exe provável de ser o principal de uma pasta de jogo/programa.</summary>
internal sealed record ExeCandidate(string Path, string Name, long Size);

/// <summary>Caixas nativas do Windows para escolher um arquivo ou uma pasta, e a heurística que acha o .exe principal de uma pasta.</summary>
internal static class FilePicker {
  private static readonly object sync = new();
  private static string? lastDir;
  private static bool lastDirLoaded;
  private static bool dialogOpen;
  private const int MaxDirs = 400;
  private const int MaxFiles = 600;
  private const int MaxMs = 2500;

  private static string LastDirFile => Path.Combine(ApolloClient.DataDir, "lastdir.txt");

  /// <summary>Última pasta usada em qualquer caixa (guardada em %LOCALAPPDATA%\ApolloConfig\lastdir.txt). Pastas de rede não entram: uma rede fora do ar travaria a abertura da caixa.</summary>
  private static string? LastDir {
    get {
      lock (sync) {
        if (!lastDirLoaded) {
          lastDirLoaded = true;
          try {
            if (File.Exists(LastDirFile)) lastDir = File.ReadAllText(LastDirFile, Encoding.UTF8).Trim();
          } catch { /* sem arquivo: usa o padrão do Windows */ }
        }
        // Rede (\\servidor, unidade mapeada) ou unidade que não existe: nem olha (a espera por um servidor desligado congela a janela por muitos segundos).
        if (string.IsNullOrEmpty(lastDir) || ProgramScanner.IsNetworkPath(lastDir)) return null;
        try { return Directory.Exists(lastDir) ? lastDir : null; } catch { return null; }
      }
    }
  }

  private static void Remember(string? dir) {
    if (string.IsNullOrEmpty(dir) || ProgramScanner.IsNetworkPath(dir)) return;
    lock (sync) {
      lastDir = dir;
      lastDirLoaded = true;
      try {
        Directory.CreateDirectory(ApolloClient.DataDir);
        File.WriteAllText(LastDirFile, dir, new UTF8Encoding(false));
      } catch { /* só não lembra da próxima vez */ }
    }
  }

  private static JsonObject Error(string msg) => new() { ["error"] = msg };

  private static JsonObject Cancelled() => new() { ["cancelled"] = true };

  /// <summary>Caixa "Abrir" do Windows para escolher o programa. Chame na thread da interface. Nunca lança.
  /// Não "segue" atalhos: um .lnk escolhido volta como .lnk (assim os argumentos e a pasta de trabalho dele não se perdem).</summary>
  public static JsonObject PickFile(IWin32Window? owner, string? title) {
    lock (sync) {
      if (dialogOpen) return Error("Já existe uma janela de escolha aberta. Termine ou feche essa primeiro.");
      dialogOpen = true;
    }
    try {
      using var dlg = new OpenFileDialog {
        Title = string.IsNullOrWhiteSpace(title) ? "Escolher o programa ou jogo" : title,
        Filter = "Programas e atalhos (*.exe;*.lnk;*.bat;*.cmd)|*.exe;*.lnk;*.bat;*.cmd|Todos os arquivos (*.*)|*.*",
        FilterIndex = 1,
        CheckFileExists = true,
        CheckPathExists = true,
        Multiselect = false,
        DereferenceLinks = false,
        RestoreDirectory = true,
        InitialDirectory = LastDir ?? "",
      };
      if ((owner == null ? dlg.ShowDialog() : dlg.ShowDialog(owner)) != DialogResult.OK) return Cancelled();
      var path = dlg.FileName;
      if (string.IsNullOrWhiteSpace(path)) return Cancelled();
      Remember(Path.GetDirectoryName(path));
      return new JsonObject { ["path"] = path };
    } catch (Exception) {
      return Error("Não consegui abrir a janela para escolher o arquivo.");
    } finally {
      lock (sync) dialogOpen = false;
    }
  }

  /// <summary>Caixa "Escolher pasta" do Windows; depois procura dentro dela os .exe prováveis do jogo. Chame na thread da interface
  /// (a procura em disco roda em segundo plano). Nunca lança.</summary>
  public static async Task<JsonObject> PickFolderAsync(IWin32Window? owner, string? title) {
    string? folder;
    lock (sync) {
      if (dialogOpen) return Error("Já existe uma janela de escolha aberta. Termine ou feche essa primeiro.");
      dialogOpen = true;
    }
    try {
      // (No .NET 8 a caixa moderna de pasta é a FolderBrowserDialog com UseDescriptionForTitle; a OpenFolderDialog só existe a partir do .NET 9.)
      using var dlg = new FolderBrowserDialog {
        Description = string.IsNullOrWhiteSpace(title) ? "Escolher a pasta do jogo" : title,
        UseDescriptionForTitle = true,
        ShowNewFolderButton = false,
        AutoUpgradeEnabled = true,
        InitialDirectory = LastDir ?? "",
      };
      if ((owner == null ? dlg.ShowDialog() : dlg.ShowDialog(owner)) != DialogResult.OK) return Cancelled();
      folder = dlg.SelectedPath;
      if (string.IsNullOrWhiteSpace(folder)) return Cancelled();
    } catch (Exception) {
      return Error("Não consegui abrir a janela para escolher a pasta.");
    } finally {
      lock (sync) dialogOpen = false;
    }
    try {
      // A próxima caixa abre na pasta que contém a escolhida (a pessoa costuma ter uma pasta "Jogos" com várias).
      Remember(Path.GetDirectoryName(folder.TrimEnd('\\')) ?? folder);
      return await DescribeFolderAsync(folder);
    } catch (Exception) {
      return new JsonObject { ["folder"] = folder, ["candidates"] = new JsonArray() };
    }
  }

  /// <summary>{ folder, candidates } para uma pasta (também usado pela flag --find-exe).</summary>
  public static JsonObject DescribeFolder(string folder) {
    var arr = new JsonArray();
    foreach (var c in FindMainExecutables(folder, null, 10)) arr.Add(new JsonObject { ["path"] = c.Path, ["name"] = c.Name, ["size"] = c.Size });
    return new JsonObject { ["folder"] = folder, ["candidates"] = arr };
  }

  /// <summary>Como <see cref="DescribeFolder"/>, em segundo plano e com prazo: um disco ou uma rede que não respondem devolvem a pasta sem candidatos. Nunca lança.</summary>
  public static async Task<JsonObject> DescribeFolderAsync(string? folder, int timeoutMs = 8000) {
    var f = folder ?? "";
    try {
      var task = Task.Run(() => DescribeFolder(f));
      if (await Task.WhenAny(task, Task.Delay(timeoutMs)) == task) return await task;
    } catch { /* devolve a pasta sem candidatos */ }
    return new JsonObject { ["folder"] = f, ["candidates"] = new JsonArray() };
  }

  // ---------- Heurística: qual é o .exe principal de uma pasta? ----------

  // Pastas que nunca têm o jogo: instaladores, redistribuíveis, relatórios de falha, dependências.
  private static readonly Regex SkipDirRx = new(
    @"^(_?commonredist|redist\w*|directx|dotnet(fx)?\d*|vcredist\w*|prerequisites?|prereqs?|__?installer|installers?|crash\w*|node_modules|\$recycle\.bin|system volume information|windows|logs?|cache|temp|tmp)$",
    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

  // Um .exe dentro de uma pasta com este nome é ferramenta do jogo (editor, SDK...), não o jogo: fica depois dos demais.
  private static readonly Regex ToolDirRx = new(
    @"^(tools?|sdk|editors?|utils?|utilities|devtools|extras?|modding|authoring|tests?|samples?)$",
    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

  // Caminhos onde jogos guardam o .exe um pouco mais fundo do que o limite normal (Source 2: game\bin\win64\cs2.exe; Unreal: Jogo\Binaries\Win64).
  // Só são olhados quando a busca normal não achou nenhum candidato "de verdade".
  private static readonly string[] DeepSubfolders = { @"game\bin\win64", @"binaries\win64", @"bin\win64" };

  private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal) {
    "microsoft", "windows", "adobe", "intel", "nvidia", "amd", "corporation", "software", "inc", "ltd", "studio", "studios", "games", "game",
    "desktop", "client", "app", "application", "pro", "edition", "version", "free", "program", "files", "tools", "tool", "the", "for", "and",
    "user", "launcher", "bit", "bits", "x64", "x86",
  };

  private sealed record Found(ExeCandidate Exe, int Sim, bool Demoted, int Depth);

  /// <summary>Executáveis prováveis do jogo/programa dentro da pasta (até 2 níveis de subpasta), o mais provável primeiro:
  /// nome parecido com o da pasta (ou com <paramref name="hint"/>), depois o que está mais perto da raiz, depois o maior arquivo. Ignora desinstaladores,
  /// instaladores, tratadores de falha, redistribuíveis e ferramentas de manutenção; servidores, editores e ferramentas ficam por último; um mesmo
  /// nome de arquivo aparece uma vez só (o mais bem colocado). Nunca lança.</summary>
  public static List<ExeCandidate> FindMainExecutables(string folder, string? hint = null, int max = 10, int maxDepth = 2) {
    var found = new List<Found>();
    try {
      var root = ProgramScanner.NormPath(folder);
      // Raiz de disco, Arquivos de Programas, AppData, Windows...: não é "a pasta de um jogo", qualquer palpite seria ruído.
      if (root == null || !Directory.Exists(root) || ProgramScanner.IsBroadFolder(root) || ProgramFilters.IsJunkPath(root.TrimEnd('\\') + "\\")) return new List<ExeCandidate>();
      var folderName = Path.GetFileName(root.TrimEnd('\\'));
      var sw = Stopwatch.StartNew();
      var opts = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint, MatchType = MatchType.Simple, MatchCasing = MatchCasing.CaseInsensitive };
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

      void AddExes(string dir) {
        try {
          foreach (var file in Directory.EnumerateFiles(dir, "*.exe", opts)) {
            if (sw.ElapsedMilliseconds >= MaxMs || found.Count >= MaxFiles) break;   // pasta enorme: devolve o que já achou
            if (!file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !seen.Add(file)) continue;
            var rel = Path.GetRelativePath(root, file);
            if (ProgramFilters.IsJunkExe(file) || ProgramFilters.IsMaintenanceExe(file) || ProgramFilters.IsJunkPath("\\" + rel)) continue;
            long size = 0;
            try { size = new FileInfo(file).Length; } catch { /* sem acesso ao tamanho */ }
            var dirs = rel.Split('\\')[..^1];
            var demoted = ProgramFilters.IsDemotedExe(file) || dirs.Any(d => ToolDirRx.IsMatch(d));
            found.Add(new Found(new ExeCandidate(file, Path.GetFileName(file), size), Similarity(Path.GetFileNameWithoutExtension(file), hint, folderName), demoted, dirs.Length));
          }
        } catch { /* pasta ilegível */ }
      }

      var queue = new Queue<(string Dir, int Depth)>();
      var level1 = new List<string>();
      queue.Enqueue((root, 0));
      var visited = 0;
      while (queue.Count > 0 && visited < MaxDirs && sw.ElapsedMilliseconds < MaxMs) {
        var (dir, depth) = queue.Dequeue();
        visited++;
        AddExes(dir);
        if (depth >= maxDepth) continue;
        try {
          foreach (var sub in Directory.EnumerateDirectories(dir, "*", opts)) {
            if (queue.Count + visited >= MaxDirs || sw.ElapsedMilliseconds >= MaxMs) break;
            if (SkipDirRx.IsMatch(Path.GetFileName(sub))) continue;
            queue.Enqueue((sub, depth + 1));
            if (depth == 0) level1.Add(sub);
          }
        } catch { /* pasta ilegível */ }
      }

      // Nada que pareça o jogo (só ferramentas, ou nada): olha os lugares fundos conhecidos (game\bin\win64, Binaries\Win64).
      if (!found.Any(f => !f.Demoted)) {
        foreach (var start in level1.Prepend(root)) {
          foreach (var rel in DeepSubfolders) {
            if (sw.ElapsedMilliseconds >= MaxMs) break;
            var deep = Path.Combine(start, rel);
            try { if (Directory.Exists(deep)) AddExes(deep); } catch { /* pasta ilegível */ }
          }
        }
      }
    } catch {
      /* devolve o que foi achado até aqui */
    }
    return found
      .OrderByDescending(f => f.Sim >= 30 ? f.Sim : 0)
      .ThenBy(f => f.Demoted)
      .ThenBy(f => f.Depth)
      .ThenByDescending(f => f.Exe.Size)
      .ThenBy(f => f.Exe.Path, StringComparer.OrdinalIgnoreCase)
      .GroupBy(f => f.Exe.Name, StringComparer.OrdinalIgnoreCase)
      .Select(g => g.First().Exe)
      .Take(Math.Max(1, max))
      .ToList();
  }

  /// <summary>Quanto o nome do .exe lembra o nome do programa/pasta: 100 igual, 70 um contém o outro, 30 a 60 palavras em comum, 0 nada.</summary>
  internal static int Similarity(string exeBaseName, params string?[] hints) {
    var e = Alnum(StripNoise(exeBaseName));
    if (e.Length < 2) return 0;
    var best = 0;
    foreach (var hint in hints) {
      if (string.IsNullOrWhiteSpace(hint)) continue;
      var h = Alnum(hint);
      if (h.Length < 2) continue;
      if (e == h) return 100;
      if ((h.Length >= 4 && e.Contains(h, StringComparison.Ordinal)) || (e.Length >= 4 && h.Contains(e, StringComparison.Ordinal))) best = Math.Max(best, 70);
      var shared = Tokens(hint).Count(t => e.Contains(t, StringComparison.Ordinal));
      if (shared > 0) best = Math.Max(best, 30 + 10 * Math.Min(shared, 3));
    }
    return best;
  }

  /// <summary>"Game-Win64-Shipping" vira "Game"; "obs64" vira "obs".</summary>
  internal static string StripNoise(string name) {
    var s = name;
    for (var i = 0; i < 4; i++) {
      var next = Regex.Replace(s, @"[-_ .]?(win64|win32|shipping|x64|x86|amd64|64bit|32bit|dx11|dx12)(?=$|[-_ .])", "", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
      next = Regex.Replace(next, @"(?<=[A-Za-z])(64|32)$", "");
      if (next == s) break;
      s = next;
    }
    return s;
  }

  internal static string Alnum(string s) {
    var f = ProgramFilters.Fold(s);
    var sb = new StringBuilder(f.Length);
    foreach (var ch in f) if (char.IsLetterOrDigit(ch)) sb.Append(ch);
    return sb.ToString();
  }

  private static IEnumerable<string> Tokens(string s) =>
    Regex.Split(s, @"[^\p{L}\p{N}]+|(?<=[a-z])(?=[A-Z])")
      .Select(ProgramFilters.Fold)
      .Where(t => t.Length >= 3 && t.Any(char.IsLetter) && !StopWords.Contains(t))
      .Distinct();
}
