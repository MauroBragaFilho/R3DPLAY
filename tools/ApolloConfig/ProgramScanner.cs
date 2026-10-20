using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ApolloConfig;

/// <summary>Um programa instalado, no formato devolvido pelo comando "installedPrograms" da ponte.</summary>
internal sealed class InstalledProgram {
  public string Name = "";
  public string Exe = "";
  public string Args = "";
  public string Dir = "";
  public string Source = "startmenu";   // startmenu | registry | apppaths
  public string? Icon;                  // PNG 32x32 em base64 (sem prefixo data:)
  internal string IconFile = "";        // de onde tirar o ícone (só durante a varredura)
  internal int IconIndex;
  internal string GroupKey = "";        // App Paths: o ProductName do .exe (peças do mesmo pacote compartilham)
  internal int Rank => Source switch { "startmenu" => 0, "registry" => 1, _ => 2 };

  public JsonObject ToJson() => new() { ["name"] = Name, ["exe"] = Exe, ["args"] = Args, ["dir"] = Dir, ["source"] = Source, ["icon"] = Icon };
}

internal sealed record ScanResult(List<InstalledProgram> Programs, long ElapsedMs) {
  public JsonObject ToJson() {
    var arr = new JsonArray();
    foreach (var p in Programs) arr.Add(p.ToJson());
    return new JsonObject { ["programs"] = arr, ["scannedMs"] = ElapsedMs };
  }
}

/// <summary>Regras que separam programas "de verdade" do lixo que aparece nas listas do Windows (desinstaladores, redistribuíveis,
/// atualizadores...). Os blocos entre as marcas PADROES-*-INICIO/FIM também são lidos por dev/check-programs.mjs:
/// uma regra por linha, no formato @"...", (sem aspas dentro). Todas valem sobre o texto já sem acentos e em minúsculas (Fold).</summary>
internal static class ProgramFilters {
  // PADROES-NOME-INICIO
  private static readonly string[] NameRules = {
    @"desinstal|uninstall|\bunins\d*\b|\buninst\b",
    @"\bsetup\b|\binstall(er|ers|ation|ing)?\b|\binstal(ar|ador|acao|ando)\b",
    @"redist|redistribu",
    @"\bruntimes?\b",
    @"(?:^|\s)\.net\b|\basp\.net\b|\bdotnet\b|\bnet (framework|runtime|sdk|core)\b",
    @"\bdirect ?x\b",
    @"\bdrivers?\b.*\d+\.\d+",
    @"\b(nvidia|amd|intel|realtek|graphics|audio|display|chipset|usb|bluetooth|wireless|wi-?fi|ethernet|network|touchpad|sound|printer|scanner|controller|firmware|bios|hid|vhid|virtual|windows)\b.*\bdrivers?\b",
    @"\bdrivers?\b.*\b(package|pack|installer|software|firmware|update|setup|support)\b",
    @"updat|upgrade|atualiza",
    @"\bhelpers?\b",
    @"crash ?(handler|report|reporter|dump|pad|sender|upload)|\breporter\b|bug ?report|error ?report|report a problem|relatar|relatorio de erro",
    @"\breadme\b|\bleia[- ]?me\b|\bdocumentation\b|\bdocumentacao\b|\bdocs?\b|\bmanuals\b",
    @"^(help|ajuda|manual)\b|\b(help|ajuda|manual)$|\b(help|ajuda|manual) (file|files|center|centre|viewer|do|da|de|of)\b|\buser (manual|guide)\b|\bguia\b",
    @"\blicen[cs]\w*|\beula\b|\bchangelog\b|release notes|\bwhat'?s new\b|novidades|o que ha de novo",
    @"\bwebsite\b|\bweb site\b|\bsite oficial\b|^samples?\b|\bsamples?$|\bsample (apps?|files|code)\b|^exemplos?\b",
    @"\brepair\b|\breparar\b|\breparo\b|\brecover(y|ing)?\b|\brecuperacao\b",
    @"visual c\+\+|\bvc\+\+|\bmsvc\b|visual j#|visual basic/c\+\+",
    @"software development kit|\bsdk\b|\bwdk\b|windows kits?|targeting pack|development libraries",
    @"\bservices?\b|\btelemetry\b|\bbackend\b|\bcontainer\b",
    @"\bphysx\b|webview|\bsilverlight\b|\b(jdk|jre)\b|development kit|\b(vigem|hidhide|npcap|winpcap|usbpcap)\b|\b(web|browser) plug-?ins?\b",
    @"^(configurar|configure|reconfigure)\b|^(about|sobre)\b|\blanguage (preferences|settings|packs?)\b|\bsafe mode\b|\breset (preferences|settings|config)",
    @"\bcomponents?\b|\bcomponentes?\b|\bcommon files\b",
  };
  // PADROES-NOME-FIM

  // PADROES-EXE-INICIO
  private static readonly string[] ExeRules = {
    @"^unins|^uninst|uninstall|desinstal",
    @"setup|installer|^install|^instal|^inst$|oalinst|prereq|^dotnetfx|^ndp\d|netfx|^dotnet-|^windowsdesktop-|^aspnetcore-",
    @"redist",
    @"update|upgrade|atualiza",
    @"helper|service$|(?:^|[^g])host$|configuration|diagcmd|^javaws$|^javacpl$",
    @"crash(handler|report|reporter|dump|pad|rpt|sender|upload|monitor|logger)|^crashes|bugreport|bugsplat|errorreport|reporter|werfault|minidump|dumpuploader|^createdump",
    @"readme|leiame|licen[cs]|^eula|^help$|^ajuda|^manual$|documentation|changelog",
    @"repair|reparar",
    @"easyanticheat|^eac($|[-_ ])|beservice|battleye|bedaisy|anticheat|punkbuster|^pbsvc|^pnkbstr|^vgc$|^vgtray",
    @"cef(sub)?process|cefsharp|qtwebengineprocess|subprocess|^msedgewebview|^crashpad",
    @"^physx",
    @"^(sunshine|sunshinesvc|apolloconfig)$",
    @"^(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|msiexec|regsvr32|regedit|conhost|explorer|control|dotnet)$",
  };
  // PADROES-EXE-FIM

  // Só para a lista de "executáveis prováveis" de uma pasta de jogo: ferramentas de manutenção que não são o jogo.
  // PADROES-MANUTENCAO-INICIO
  private static readonly string[] MaintenanceRules = {
    @"patcher|^patch|configurator|^config(ure)?$|settings$|^setting|diagnos|^verify|^benchmark|^dxdiag|^support",
  };
  // PADROES-MANUTENCAO-FIM

  // Executáveis que continuam na lista, mas ficam por último ("provável" é outro).
  private static readonly string[] DemoteRules = {
    @"server|dedicated|editor|tool|test|console|service|x86|(^|[^0-9])32($|[^0-9])|debug",
  };

  // Trechos de caminho (em minúsculas, já sem acentos) que nunca são um programa do usuário.
  // PADROES-CAMINHO-INICIO
  private static readonly string[] PathFragments = {
    @"\windowsapps\",
    @"\package cache\",
    @"\common files\",
    @"\installer2\",
    @"\$patchcache$\",
    @"\windows kits\",
    @"\edgewebview\",
    @"\$recycle.bin\",
    @"\appdata\local\temp\",
    @"\_commonredist\",
    @"\redist\",
    @"\redistributables\",
    @"\vcredist\",
    @"\directx\",
    @"\dotnetfx\",
    @"\prerequisites\",
    @"\node_modules\",
    @"\winget\packages\",
    @"\vfs\",
    @"\windows mail\",
    @"\windows nt\",
    @"\windows defender\",
    @"\windows photo viewer\",
    @"\windows sidebar\",
    @"\windows portable devices\",
    @"\internet explorer\",
  };
  // PADROES-CAMINHO-FIM

  private static readonly Regex NameRx = Build(NameRules);
  private static readonly Regex ExeRx = Build(ExeRules);
  private static readonly Regex MaintenanceRx = Build(MaintenanceRules);
  private static readonly Regex DemoteRx = Build(DemoteRules);
  private static readonly string WinDir = Fold(Environment.GetFolderPath(Environment.SpecialFolder.Windows)).TrimEnd('\\') + "\\";

  private static Regex Build(string[] rules) =>
    new(string.Join("|", rules.Select(r => "(?:" + r + ")")), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

  private static bool Test(Regex rx, string folded) {
    try { return rx.IsMatch(folded); } catch (RegexMatchTimeoutException) { return false; }
  }

  /// <summary>Minúsculas e sem acentos: "Instalação" vira "instalacao".</summary>
  public static string Fold(string? s) {
    if (string.IsNullOrEmpty(s)) return "";
    try {
      var d = s.Normalize(NormalizationForm.FormD);
      var sb = new StringBuilder(d.Length);
      foreach (var ch in d) {
        if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark) sb.Append(char.ToLowerInvariant(ch));
      }
      return sb.ToString();
    } catch (ArgumentException) {
      return s.ToLowerInvariant();   // texto com caracteres inválidos: sem tirar acentos
    }
  }

  /// <summary>O nome (de atalho ou do registro) é de desinstalador, instalador, componente, atualizador, ajuda, etc.?</summary>
  public static bool IsJunkName(string? name) => !string.IsNullOrWhiteSpace(name) && Test(NameRx, Fold(name));

  /// <summary>O nome do arquivo .exe (ou o caminho) é de desinstalador, instalador, atualizador, ajudante, relatório de falhas, etc.?</summary>
  public static bool IsJunkExe(string pathOrFile) => Test(ExeRx, Fold(BaseName(pathOrFile)));

  public static bool IsMaintenanceExe(string pathOrFile) => Test(MaintenanceRx, Fold(BaseName(pathOrFile)));

  public static bool IsDemotedExe(string pathOrFile) => Test(DemoteRx, Fold(BaseName(pathOrFile)));

  /// <summary>Dentro do Windows (inclui System32/SysWOW64) ou em pastas de instaladores, redistribuíveis, cache de pacotes, apps da Loja.</summary>
  public static bool IsJunkPath(string fullPath) {
    var p = Fold(fullPath).Replace('/', '\\');
    if (p.StartsWith(WinDir, StringComparison.Ordinal)) return true;
    foreach (var frag in PathFragments) {
      if (p.Contains(frag, StringComparison.Ordinal)) return true;
    }
    return false;
  }

  private static string BaseName(string pathOrFile) {
    var f = pathOrFile.Replace('/', '\\');
    var i = f.LastIndexOf('\\');
    if (i >= 0) f = f[(i + 1)..];
    return f.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? f[..^4] : f;
  }

  /// <summary>Tira do nome o que sobra de instalador: versão no fim ("7-Zip 23.01 (x64)" vira "7-Zip"), arquitetura, "(User)".</summary>
  public static string CleanName(string? name) {
    var original = (name ?? "").Trim();
    var s = Regex.Replace(original, @"\s{2,}", " ");
    const RegexOptions ic = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    for (var i = 0; i < 6; i++) {
      var prev = s;
      s = Regex.Replace(s, @"\s*[\(\[][^\)\]]*\b(x64|x86|amd64|64-?bits?|32-?bits?|user|machine|usuario|pt-?br|en-?us)\b[^\)\]]*[\)\]]\s*$", "", ic).Trim();
      s = Regex.Replace(s, @"[\s,\-–]+(x64|x86|amd64|64-?bits?|32-?bits?)\s*$", "", ic).Trim();
      s = Regex.Replace(s, @"\s+(version|versao|versão)\s+v?\d[\w\.\+\-]*\s*$", "", ic).Trim();
      s = Regex.Replace(s, @"[\s\-–]+v?\d+(\.\d+)+[\w\.\+\-]*\s*$", "", ic).Trim();
      s = Regex.Replace(s, @"\s+(version|versao|versão)\s*$", "", ic).Trim();
      if (s == prev) break;
    }
    return s.Length >= 2 ? s : original;
  }

  /// <summary>"Minecraft Launcher" vira "Minecraft" (a pessoa pensa no jogo); "Epic Games Launcher" continua como é.</summary>
  public static string StripLauncher(string name) {
    var m = Regex.Match(name, @"^(.*\S)\s+Launcher$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (!m.Success) return name;
    var rest = m.Groups[1].Value;
    if (rest.Length < 3 || Regex.IsMatch(rest, @"\b(games?|store|stores)$", RegexOptions.IgnoreCase)) return name;
    return rest;
  }
}

/// <summary>Atalhos .lnk lidos pelo COM do shell (IShellLink): nunca executa nada e nunca "resolve" o atalho (sem busca em disco, sem janelas).</summary>
internal static class ShellLinks {
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string? pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  private class ShellLinkObject { }

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern uint MsiGetShortcutTarget(string szShortcutPath, StringBuilder szProductCode, StringBuilder szFeatureId, StringBuilder szComponentCode);

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern int MsiGetComponentPath(string szProduct, string szComponent, StringBuilder lpPathBuf, ref int pcchBuf);

  internal sealed record LinkInfo(string Target, string Args, string WorkDir, string IconPath, int IconIndex);

  /// <summary>Lê o atalho. PRECISA rodar numa thread STA. Devolve null se o arquivo não é um atalho válido.</summary>
  public static LinkInfo? Read(string lnkPath) {
    object? obj = null;
    try {
      obj = new ShellLinkObject();
      ((IPersistFile) obj).Load(lnkPath, 0);
      var link = (IShellLinkW) obj;
      var target = new StringBuilder(1024);
      var args = new StringBuilder(4096);
      var dir = new StringBuilder(1024);
      var icon = new StringBuilder(1024);
      link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
      link.GetArguments(args, args.Capacity);
      link.GetWorkingDirectory(dir, dir.Capacity);
      link.GetIconLocation(icon, icon.Capacity, out var idx);
      return new LinkInfo(target.ToString(), args.ToString(), dir.ToString(), icon.ToString(), idx);
    } catch {
      return null;
    } finally {
      if (obj != null) { try { Marshal.FinalReleaseComObject(obj); } catch { /* já liberado */ } }
    }
  }

  /// <summary>Atalhos "anunciados" do Windows Installer (apontam para um ícone em C:\Windows\Installer): descobre o programa de verdade.</summary>
  public static string? ResolveAdvertised(string lnkPath) {
    try {
      var product = new StringBuilder(40);
      var feature = new StringBuilder(40);
      var component = new StringBuilder(40);
      if (MsiGetShortcutTarget(lnkPath, product, feature, component) != 0) return null;
      var buf = new StringBuilder(1024);
      var len = buf.Capacity;
      var state = MsiGetComponentPath(product.ToString(), component.ToString(), buf, ref len);
      return state is 3 or 4 ? buf.ToString() : null;   // INSTALLSTATE_LOCAL / INSTALLSTATE_SOURCE
    } catch {
      return null;
    }
  }

  /// <summary>Roda a função numa thread STA nova (o COM do shell exige) e espera até o prazo; null se estourar ou falhar.</summary>
  public static T? RunSta<T>(Func<T?> fn, int timeoutMs) where T : class {
    T? result = null;
    var t = new Thread(() => { try { result = fn(); } catch { result = null; } }) { IsBackground = true, Name = "r3d-sta" };
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    return t.Join(timeoutMs) ? result : null;
  }
}

/// <summary>Procura os programas instalados (Menu Iniciar, Desinstalar Programas, App Paths) e devolve nome, .exe, ícone.</summary>
internal static class ProgramScanner {
  private const int MaxPrograms = 800;
  private const string UninstallPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
  private const string AppPathsPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
  private static readonly object gate = new();
  private static Task<ScanResult>? inflight;
  private static readonly ConcurrentDictionary<string, string?> IconCache = new();
  private static readonly CompareInfo PtBr = CultureInfo.GetCultureInfo("pt-BR").CompareInfo;

  /// <summary>Varredura sem travar a interface; chamadas simultâneas dividem a mesma varredura.</summary>
  public static Task<ScanResult> ScanAsync() {
    lock (gate) {
      return inflight ??= Task.Run(() => {
        try { return Scan(); } finally { lock (gate) inflight = null; }
      });
    }
  }

  /// <summary>Resposta do comando "installedPrograms": nunca lança e nunca passa de ~15 s (uma varredura presa não prende a interface).</summary>
  public static async Task<JsonObject> ScanJsonAsync() {
    try {
      var scan = ScanAsync();
      if (await Task.WhenAny(scan, Task.Delay(15000)) != scan) return new JsonObject { ["error"] = "A busca de programas demorou mais do que o esperado. Tente de novo em alguns instantes." };
      return (await scan).ToJson();
    } catch (Exception) {
      return new JsonObject { ["error"] = "Não consegui listar os programas instalados neste computador." };
    }
  }

  private const int TotalBudgetMs = 12000;   // prazo geral: o que não deu tempo fica sem ícone/fora da lista

  public static ScanResult Scan() {
    var sw = Stopwatch.StartNew();
    // Cada etapa espera no máximo o seu teto e o que sobrar do prazo geral; uma etapa travada (disco ou rede lentos) é abandonada e o que
    // ela já achou vale. Nenhuma etapa toca caminhos de rede (a espera por um servidor desligado passa de 40 s).
    int Left(int cap) => (int) Math.Max(300, Math.Min(cap, TotalBudgetMs - sw.ElapsedMilliseconds));
    var all = new List<InstalledProgram>();
    try { all.AddRange(FromStartMenu(Left(8000))); } catch { /* uma fonte com problema não derruba as outras */ }
    Trace($"menu iniciar: {all.Count} em {sw.ElapsedMilliseconds} ms");

    var fromRegistry = new ConcurrentBag<InstalledProgram>();
    var menuSnapshot = all.ToArray();
    RunBounded(ct => FromRegistry(menuSnapshot, fromRegistry, ct), Left(4000));
    all.AddRange(fromRegistry.ToArray());
    Trace($"registro: {all.Count} em {sw.ElapsedMilliseconds} ms");

    var fromAppPaths = new ConcurrentBag<InstalledProgram>();
    var knownSnapshot = all.ToArray();
    RunBounded(ct => FromAppPaths(knownSnapshot, fromAppPaths, ct), Left(2500));
    all.AddRange(DropRepeatedNames(fromAppPaths.ToList()));
    Trace($"app paths: {all.Count} em {sw.ElapsedMilliseconds} ms");

    var list = Merge(all);
    Trace($"junção: {list.Count} em {sw.ElapsedMilliseconds} ms");

    // Ícones em paralelo, sobre uma cópia da lista (a ordenação abaixo mexe na lista original). Passou do prazo: os que faltam ficam sem ícone.
    var snapshot = list.ToArray();
    var iconCts = new CancellationTokenSource();
    var iconTask = Task.Run(() => {
      try {
        Parallel.ForEach(snapshot, new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(Environment.ProcessorCount * 2, 4, 12), CancellationToken = iconCts.Token }, p => {
          p.Icon = IconPng(p.IconFile, p.IconIndex) ?? (p.IconFile.Equals(p.Exe, StringComparison.OrdinalIgnoreCase) ? null : IconPng(p.Exe, 0));
        });
      } catch { /* cancelado ou ícone problemático: os que faltam ficam sem ícone */ }
    });
    try { if (!iconTask.Wait(Left(5000))) iconCts.Cancel(); } catch { /* tarefa falhou: segue sem ícones */ }

    list.Sort((a, b) => PtBr.Compare(a.Name, b.Name, CompareOptions.IgnoreCase));
    Trace($"ícones: pronto em {sw.ElapsedMilliseconds} ms");
    return new ScanResult(list, sw.ElapsedMilliseconds);
  }

  /// <summary>Roda o trabalho numa thread própria e espera até o prazo; se estourar, avisa a thread para parar (ct) e segue sem esperar por ela.</summary>
  private static void RunBounded(Action<CancellationToken> work, int timeoutMs) {
    var cts = new CancellationTokenSource();
    var t = new Thread(() => { try { work(cts.Token); } catch { /* fonte com problema: vale o que já foi achado */ } }) { IsBackground = true, Name = "r3d-scan" };
    t.Start();
    if (!t.Join(timeoutMs)) cts.Cancel();
  }

  /// <summary>Só para testes: R3D_PROGRAMS_TRACE=arquivo grava os tempos de cada etapa da varredura.</summary>
  private static void Trace(string text) {
    if (Environment.GetEnvironmentVariable("R3D_PROGRAMS_TRACE") is not { Length: > 0 } file) return;
    try { File.AppendAllText(file, text + Environment.NewLine); } catch { /* sem registro */ }
  }

  // ---------- Fonte 1: atalhos do Menu Iniciar ----------

  private static IEnumerable<string> StartMenuRoots() {
    yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
    yield return Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    // Só para testes: uma pasta extra de atalhos (R3D_PROGRAMS_EXTRA_LNK_DIR).
    if (Environment.GetEnvironmentVariable("R3D_PROGRAMS_EXTRA_LNK_DIR") is { Length: > 0 } extra) yield return extra;
  }

  private static List<InstalledProgram> FromStartMenu(int waitMs) {
    var files = new List<string>();
    var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint, MatchType = MatchType.Simple, MatchCasing = MatchCasing.CaseInsensitive };
    foreach (var root in StartMenuRoots().Where(r => !string.IsNullOrEmpty(r) && !IsNetworkPath(r)).Distinct(StringComparer.OrdinalIgnoreCase)) {
      try {
        if (Directory.Exists(root)) files.AddRange(Directory.EnumerateFiles(root, "*.lnk", opts).Where(f => f.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)));
      } catch { /* pasta ilegível: ignora */ }
    }
    var queue = new ConcurrentQueue<string>(files);
    var found = new ConcurrentBag<InstalledProgram>();
    var stop = new CancellationTokenSource();
    var threads = new List<Thread>();
    for (var i = 0; i < Math.Clamp(Environment.ProcessorCount, 4, 8); i++) {
      // O COM do shell exige uma thread STA; cada thread cuida de uma parte dos atalhos.
      var t = new Thread(() => {
        while (!stop.IsCancellationRequested && queue.TryDequeue(out var f)) {
          try { if (FromLink(f) is { } p && !stop.IsCancellationRequested) found.Add(p); } catch { /* atalho estranho: ignora */ }
        }
      }) { IsBackground = true, Name = "r3d-lnk" };
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      threads.Add(t);
    }
    // Espera as threads até o prazo. Com a fila já vazia, dá só mais uma folga curta para quem ainda trabalha: um atalho preso
    // (disco que não responde) não pode segurar a lista inteira até o fim do prazo.
    var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
    DateTime? drainedAt = null;
    while (threads.Any(t => t.IsAlive)) {
      var now = DateTime.UtcNow;
      if (now >= deadline) break;
      if (queue.IsEmpty) {
        drainedAt ??= now;
        if (now - drainedAt.Value > TimeSpan.FromMilliseconds(2500)) break;
      }
      Thread.Sleep(15);
    }
    stop.Cancel();   // quem ficou preso termina sozinho depois, sem mexer mais na lista
    return found.ToArray().ToList();
  }

  private static InstalledProgram? FromLink(string lnkPath) {
    var link = ShellLinks.Read(lnkPath);
    if (link == null) return null;
    var name = Path.GetFileNameWithoutExtension(lnkPath).Trim();
    if (name.Length == 0 || ProgramFilters.IsJunkName(name)) return null;

    var target = link.Target;
    if (string.IsNullOrWhiteSpace(target) || target.Contains(@"\Windows\Installer\", StringComparison.OrdinalIgnoreCase)) {
      target = ShellLinks.ResolveAdvertised(lnkPath) ?? target;
    }
    var exe = NormPath(target);
    if (exe == null || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return null;   // pasta, documento, .msc, .bat...
    if (IsNetworkPath(exe)) return null;   // programa na rede: não dá para conferir sem arriscar travar, e não é um jogo deste PC
    var args = link.Args.Trim();
    var iconExe = exe;
    var squirrel = TrySquirrel(exe, args, out var sq);
    if (squirrel) { exe = sq.Exe; args = sq.Args; iconExe = sq.IconExe; }
    if (squirrel ? !(File.Exists(exe) && !ProgramFilters.IsJunkPath(exe)) : !ExeUsable(exe)) return null;

    var dir = ChooseWorkDir(link.WorkDir, exe);
    var p = new InstalledProgram { Name = name, Exe = exe, Args = args, Dir = dir, Source = "startmenu", IconFile = iconExe, IconIndex = 0 };
    // O ícone que a pessoa vê no Menu Iniciar é o do atalho, se for de um .ico/.exe/.dll fora do Windows.
    var iconPath = NormPath(link.IconPath);
    if (iconPath != null && IsIconSource(iconPath) && SafeFileExists(iconPath) && !ProgramFilters.IsJunkPath(iconPath)) { p.IconFile = iconPath; p.IconIndex = link.IconIndex; }
    return p;
  }

  /// <summary>Pasta de trabalho do atalho ("Iniciar em"), sem as que não servem para guardar no painel: inexistente, de rede, a pasta de versão de um
  /// app Squirrel (app-1.2.3, apagada na próxima atualização), a pasta do Menu Iniciar e a Área de Trabalho. Nesses casos, a pasta do próprio .exe.</summary>
  internal static string ChooseWorkDir(string? rawWorkDir, string exe) {
    var exeDir = TrimDir(Path.GetDirectoryName(exe) ?? "");
    var dir = NormPath(rawWorkDir);
    if (dir == null || IsNetworkPath(dir) || !Directory.Exists(dir) || IsVolatileDir(dir)) return exeDir;
    return TrimDir(dir);
  }

  private static readonly Regex VersionedDirRx = new(@"^app-\d+(\.\d+)+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

  // O Menu Iniciar (do usuário e de todos) e a Área de Trabalho: um "Iniciar em" apontando para cá é só o lugar do atalho, não o do programa.
  private static readonly string[] ShortcutFolders = new[] {
    Environment.SpecialFolder.CommonPrograms, Environment.SpecialFolder.Programs, Environment.SpecialFolder.StartMenu, Environment.SpecialFolder.CommonStartMenu,
    Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.CommonDesktopDirectory,
  }.Select(f => Environment.GetFolderPath(f).TrimEnd('\\')).Where(f => f.Length > 0).ToArray();

  private static bool IsVolatileDir(string dir) {
    var d = dir.TrimEnd('\\');
    if (VersionedDirRx.IsMatch(Path.GetFileName(d))) return true;
    return ShortcutFolders.Any(root => d.Equals(root, StringComparison.OrdinalIgnoreCase) || d.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase));
  }

  /// <summary>Resultado de <see cref="TrySquirrel"/>: o comando que continua valendo depois de atualizações e o .exe real (para o ícone e os dados do programa).</summary>
  internal sealed record SquirrelCommand(string Exe, string Args, string IconExe);

  /// <summary>Apps instalados pelo Squirrel (Discord, GitHub Desktop...) abrem por "Update.exe --processStart App.exe". A pasta da versão (app-1.2.3\App.exe)
  /// é apagada na próxima atualização, então não pode ser gravada. Usa o App.exe da pasta raiz, se existir (é fixo); senão mantém o comando do
  /// próprio atalho (Update.exe + argumentos), que o Squirrel garante que continua funcionando. Só vale se existir mesmo uma versão instalada.</summary>
  internal static bool TrySquirrel(string exe, string args, out SquirrelCommand cmd) {
    cmd = new SquirrelCommand(exe, args, exe);
    if (!Path.GetFileName(exe).Equals("update.exe", StringComparison.OrdinalIgnoreCase)) return false;
    var m = Regex.Match(args, @"--process-?start(?:AndWait)?[ =]+""?([^"" ]+\.exe)""?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (!m.Success) return false;
    try {
      var root = Path.GetDirectoryName(exe);
      if (root == null) return false;
      var wanted = Path.GetFileName(m.Groups[1].Value);
      var stub = Path.Combine(root, wanted);
      foreach (var d in Directory.GetDirectories(root, "app-*").OrderByDescending(d => VersionOf(Path.GetFileName(d)))) {
        var candidate = Path.Combine(d, wanted);
        if (!File.Exists(candidate)) continue;
        cmd = File.Exists(stub) ? new SquirrelCommand(stub, "", stub) : new SquirrelCommand(exe, args, candidate);
        return true;
      }
    } catch { /* sem acesso à pasta */ }
    return false;
  }

  private static Version VersionOf(string appDirName) => Version.TryParse(appDirName.AsSpan(4), out var v) ? v : new Version(0, 0);

  // ---------- Fonte 2: Desinstalar Programas (registro) ----------

  private sealed record RegEntry(string KeyName, string Name, string? DisplayIcon, string? InstallLocation, string? UninstallString);

  private static bool IsOne(object? v) => v switch { int i => i == 1, string s => s.Trim() == "1", _ => false };

  private static List<RegEntry> ReadUninstallEntries() {
    var list = new List<RegEntry>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var views = new[] { (RegistryHive.LocalMachine, RegistryView.Registry64), (RegistryHive.LocalMachine, RegistryView.Registry32), (RegistryHive.CurrentUser, RegistryView.Registry64), (RegistryHive.CurrentUser, RegistryView.Registry32) };
    foreach (var (hive, view) in views) {
      try {
        using var root = RegistryKey.OpenBaseKey(hive, view);
        using var uninstall = root.OpenSubKey(UninstallPath);
        if (uninstall == null) continue;
        foreach (var sub in uninstall.GetSubKeyNames()) {
          try {
            if (sub.StartsWith("Steam App ", StringComparison.OrdinalIgnoreCase)) continue;   // jogos da Steam: o painel já os adiciona pela "Detectar jogos"
            using var k = uninstall.OpenSubKey(sub);
            if (k == null) continue;
            var name = (k.GetValue("DisplayName") as string)?.Trim();
            if (string.IsNullOrEmpty(name) || IsOne(k.GetValue("SystemComponent"))) continue;
            if (!string.IsNullOrEmpty(k.GetValue("ParentKeyName") as string) || !string.IsNullOrEmpty(k.GetValue("ParentDisplayName") as string)) continue;   // atualização de outro programa
            if (k.GetValue("ReleaseType") is "Security Update" or "Update Rollup" or "Hotfix" or "ServicePack" or "Update") continue;
            if (Regex.IsMatch(name, @"\bKB\d{6,}\b") || Regex.IsMatch(sub, @"^KB\d{6,}")) continue;
            var entry = new RegEntry(sub, name, k.GetValue("DisplayIcon") as string, k.GetValue("InstallLocation") as string, k.GetValue("UninstallString") as string);
            if (seen.Add(name + "|" + entry.InstallLocation + "|" + entry.DisplayIcon)) list.Add(entry);
          } catch { /* chave ilegível */ }
        }
      } catch { /* hive indisponível */ }
    }
    return list;
  }

  /// <summary>Acrescenta em <paramref name="sink"/> os programas das chaves de desinstalação que o Menu Iniciar ainda não cobre.</summary>
  private static void FromRegistry(IReadOnlyCollection<InstalledProgram> menu, ConcurrentBag<InstalledProgram> sink, CancellationToken ct) {
    var entries = ReadUninstallEntries();
    var menuNames = new HashSet<string>(menu.Select(m => ProgramFilters.Fold(m.Name)), StringComparer.Ordinal);
    var menuExes = menu.Select(m => m.Exe).ToArray();
    try {
      Parallel.ForEach(entries, new ParallelOptions { MaxDegreeOfParallelism = 6, CancellationToken = ct }, e => {
        try { if (ResolveRegistryEntry(e, menuNames, menuExes) is { } p) sink.Add(p); } catch { /* entrada estranha */ }
      });
    } catch (OperationCanceledException) { /* prazo */ }
  }

  private static InstalledProgram? ResolveRegistryEntry(RegEntry e, HashSet<string> menuNames, string[] menuExes) {
    if (ProgramFilters.IsJunkName(e.Name)) return null;
    var name = ProgramFilters.CleanName(e.Name);
    if (name.Length < 2 || ProgramFilters.IsJunkName(name)) return null;

    var (iconSpec, iconIndex) = ParseIconSpec(e.DisplayIcon);
    var iconPath = NormPath(iconSpec);
    string? exe = null;
    var iconFile = "";
    if (iconPath != null && iconPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && ExeUsable(iconPath)) {
      exe = iconPath;     // o próprio instalador marcou o programa como ícone
      iconFile = iconPath;
    }

    // Um .exe que mora na mesma pasta de um programa do Menu Iniciar é peça dele (ajudante, serviço, "Fotos" do OneDrive...), não outro programa.
    var folded = ProgramFilters.Fold(name);
    if (exe != null && menuExes.Any(m => string.Equals(Path.GetDirectoryName(m), Path.GetDirectoryName(exe), StringComparison.OrdinalIgnoreCase))) return null;

    if (exe == null) {
      // Já listado pelo Menu Iniciar (mesmo nome, ou um contém o outro: "Microsoft OneDrive" e "OneDrive").
      if (menuNames.Any(n => n == folded || (n.Length >= 5 && folded.Length >= 5 && (folded.Contains(n, StringComparison.Ordinal) || n.Contains(folded, StringComparison.Ordinal))))) return null;
      // Pastas onde o programa pode estar: local de instalação, pasta do ícone/desinstalador (um desinstalador fica junto do programa).
      var folders = new List<string>();
      void AddFolder(string? raw) {
        var f = NormPath(raw);
        if (f == null || IsNetworkPath(f)) return;   // (nada de E/S em caminho de rede: um servidor desligado trava por mais de 40 s)
        if (File.Exists(f)) f = Path.GetDirectoryName(f);   // às vezes o "local" é o próprio arquivo
        f = f?.TrimEnd('\\');
        if (!string.IsNullOrEmpty(f) && !folders.Contains(f, StringComparer.OrdinalIgnoreCase)) folders.Add(f);
      }
      if (NormPath(e.InstallLocation) is { } loc && loc.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && ExeUsable(loc)) exe = loc;
      AddFolder(e.InstallLocation);
      if (iconPath != null && iconPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) AddFolder(iconPath);
      AddFolder(ExeOfCommand(e.UninstallString));

      foreach (var folder in folders) {
        if (exe != null) break;
        if (!Directory.Exists(folder) || IsBroadFolder(folder) || ProgramFilters.IsJunkPath(folder + "\\")) continue;
        if (menuExes.Any(m => m.StartsWith(folder + "\\", StringComparison.OrdinalIgnoreCase))) return null;   // o Menu Iniciar já cobre esta pasta
        var found = FilePicker.FindMainExecutables(folder, name, 6);
        if (found.Count == 0) continue;
        // Só aceita o palpite se o nome do .exe lembra o do programa, ou se é o único candidato: evita "programa X" abrir um .exe qualquer.
        var best = found[0];
        if (FilePicker.Similarity(Path.GetFileNameWithoutExtension(best.Path), name, Path.GetFileName(folder)) >= 30 || (found.Count == 1 && DepthBelow(folder, best.Path) <= 1)) exe = best.Path;
      }
    }
    if (exe == null) return null;

    if (iconFile.Length == 0) {
      // Um .ico escolhido pelo instalador serve, desde que não seja o ícone do próprio instalador.
      iconFile = iconPath != null && iconPath.EndsWith(".ico", StringComparison.OrdinalIgnoreCase) && SafeFileExists(iconPath) && !Regex.IsMatch(Path.GetFileName(iconPath), @"install|setup|pkg|remove", RegexOptions.IgnoreCase) ? iconPath : exe;
    }
    return new InstalledProgram { Name = name, Exe = exe, Args = "", Dir = Path.GetDirectoryName(exe) ?? "", Source = "registry", IconFile = iconFile, IconIndex = iconFile == iconPath ? iconIndex : 0 };
  }

  private static int DepthBelow(string folder, string file) {
    var rel = Path.GetRelativePath(folder, file);
    return rel.Count(c => c == '\\');
  }

  /// <summary>"C:\x\app.exe,0", "\"C:\x\app.exe\",1" ou "C:\x\app.ico" → (caminho, índice).</summary>
  internal static (string? Path, int Index) ParseIconSpec(string? spec) {
    if (string.IsNullOrWhiteSpace(spec)) return (null, 0);
    var s = spec.Trim();
    var index = 0;
    if (s.StartsWith('"')) {
      var close = s.IndexOf('"', 1);
      if (close < 0) return (s.Trim('"'), 0);
      var rest = s[(close + 1)..].Trim();
      if (rest.StartsWith(',') && int.TryParse(rest[1..].Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var i1)) index = i1;
      return (s[1..close], index);
    }
    var comma = s.LastIndexOf(',');
    if (comma > 0 && int.TryParse(s[(comma + 1)..].Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var i2)) return (s[..comma], i2);
    return (s, 0);
  }

  /// <summary>Caminho do .exe no começo de uma linha de comando (UninstallString): aspas ou até o primeiro ".exe".</summary>
  internal static string? ExeOfCommand(string? cmd) {
    if (string.IsNullOrWhiteSpace(cmd)) return null;
    var s = cmd.Trim();
    if (s.StartsWith('"')) {
      var close = s.IndexOf('"', 1);
      return close > 1 ? s[1..close] : null;
    }
    var i = s.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
    return i > 0 ? s[..(i + 4)] : null;
  }

  // ---------- Fonte 3: App Paths ----------

  /// <summary>Acrescenta em <paramref name="sink"/> os .exe registrados em App Paths que ainda não estão na lista.</summary>
  private static void FromAppPaths(IReadOnlyCollection<InstalledProgram> known, ConcurrentBag<InstalledProgram> sink, CancellationToken ct) {
    var knownExes = new HashSet<string>(known.Select(k => k.Exe), StringComparer.OrdinalIgnoreCase);
    var views = new[] { (RegistryHive.LocalMachine, RegistryView.Registry64), (RegistryHive.LocalMachine, RegistryView.Registry32), (RegistryHive.CurrentUser, RegistryView.Registry64) };
    foreach (var (hive, view) in views) {
      try {
        using var root = RegistryKey.OpenBaseKey(hive, view);
        using var paths = root.OpenSubKey(AppPathsPath);
        if (paths == null) continue;
        foreach (var sub in paths.GetSubKeyNames()) {
          if (ct.IsCancellationRequested) return;
          try {
            if (!sub.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
            using var k = paths.OpenSubKey(sub);
            var exe = NormPath(ExeOfCommand(k?.GetValue(null) as string));
            if (exe == null || !knownExes.Add(exe) || !ExeUsable(exe)) continue;
            var (product, description, company, _) = ProgramInspector.ReadVersion(exe);
            var name = ProgramInspector.PickName(product, description, Path.GetFileNameWithoutExtension(exe), company) ?? ProgramInspector.FallbackName(exe);
            name = ProgramFilters.CleanName(name);
            if (name.Length < 2 || ProgramFilters.IsJunkName(name)) continue;
            sink.Add(new InstalledProgram { Name = name, Exe = exe, Args = "", Dir = TrimDir(Path.GetDirectoryName(exe) ?? ""), Source = "apppaths", IconFile = exe, GroupKey = ProgramFilters.Fold(product) });
          } catch { /* entrada estranha */ }
        }
      } catch { /* hive indisponível */ }
    }
  }

  /// <summary>O App Paths é a fonte menos confiável (também lista peças internas de pacotes, como o Office): um nome, ou um ProductName,
  /// que serve a vários .exe é descartado.</summary>
  private static List<InstalledProgram> DropRepeatedNames(List<InstalledProgram> items) {
    HashSet<string> Repeated(Func<InstalledProgram, string> key) =>
      items.Select(key).Where(k => k.Length > 0).GroupBy(k => k).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
    var names = Repeated(r => ProgramFilters.Fold(r.Name));
    var products = Repeated(r => r.GroupKey);
    items.RemoveAll(r => names.Contains(ProgramFilters.Fold(r.Name)) || (r.GroupKey.Length > 0 && products.Contains(r.GroupKey)));
    return items;
  }

  // ---------- Junção, filtros comuns e utilitários ----------

  private static string NormArgs(string args) => Regex.Replace(args.Trim(), @"\s+", " ").ToLowerInvariant();

  /// <summary>Dois nomes do mesmo .exe que se referem ao mesmo programa: iguais ou um contém o outro ("VLC media player" e "VLC media player skinned").</summary>
  private static bool NamesRelated(string a, string b) {
    var fa = ProgramFilters.Fold(a).Trim();
    var fb = ProgramFilters.Fold(b).Trim();
    if (fa.Length == 0 || fb.Length == 0) return false;
    return fa == fb || fa.Contains(fb, StringComparison.Ordinal) || fb.Contains(fa, StringComparison.Ordinal);
  }

  /// <summary>Um item por programa. O mesmo .exe (sem diferenciar maiúsculas) com os mesmos argumentos, ou com nomes que se contêm, é um só: fica o do Menu
  /// Iniciar, depois o do registro, depois o App Paths; no mesmo grupo, o de nome mais curto e, em empate, o sem argumentos. Atalhos do mesmo .exe com argumentos
  /// e nomes diferentes (um launcher para vários jogos: VALORANT e League of Legends no Riot Client) continuam separados. No máximo 800.</summary>
  private static List<InstalledProgram> Merge(List<InstalledProgram> all) {
    var kept = new List<InstalledProgram>();
    foreach (var g in all.Where(p => p.Exe.Length > 0).GroupBy(p => p.Exe, StringComparer.OrdinalIgnoreCase)) {
      var chosen = new List<InstalledProgram>();
      foreach (var p in g.OrderBy(p => p.Rank).ThenBy(p => p.Name.Length).ThenBy(p => p.Args.Length > 0 ? 1 : 0).ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase)) {
        if (chosen.Any(c => NormArgs(c.Args) == NormArgs(p.Args) || NamesRelated(c.Name, p.Name))) continue;
        chosen.Add(p);
      }
      kept.AddRange(chosen);
    }
    // Mesmo nome na mesma pasta e com os mesmos argumentos (ex.: duas versões do instalador deixaram dois itens): um só.
    var unique = kept
      .GroupBy(p => ProgramFilters.Fold(p.Name) + "|" + p.Dir.ToLowerInvariant() + "|" + NormArgs(p.Args))
      .Select(g => g.OrderBy(p => p.Rank).ThenBy(p => p.Args.Length > 0 ? 1 : 0).First());
    return unique.OrderBy(p => p.Rank).Take(MaxPrograms).ToList();
  }

  private static bool ExeUsable(string exe) {
    try {
      return !IsNetworkPath(exe) && File.Exists(exe) && !ProgramFilters.IsJunkPath(exe) && !ProgramFilters.IsJunkExe(exe);
    } catch {
      return false;
    }
  }

  /// <summary>O caminho está em rede (\\servidor\pasta, unidade mapeada) ou em uma unidade que não existe? Só olha o tipo da unidade, sem tocar o disco nem a
  /// rede: File.Exists num servidor desligado leva mais de 40 s. Os caminhos \\?\ locais já saem de NormPath sem o prefixo.</summary>
  internal static bool IsNetworkPath(string? path) {
    if (string.IsNullOrEmpty(path)) return false;
    try {
      var p = path;
      if (p.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return true;
      if (p.StartsWith(@"\\?\", StringComparison.Ordinal) || p.StartsWith(@"\\.\", StringComparison.Ordinal)) p = p[4..];
      else if (p.StartsWith(@"\\", StringComparison.Ordinal)) return true;
      if (p.Length >= 2 && char.IsAsciiLetter(p[0]) && p[1] == ':') {
        var t = new DriveInfo(p[..1]).DriveType;
        return t is DriveType.Network or DriveType.NoRootDirectory;
      }
      return false;
    } catch {
      return false;
    }
  }

  private static bool SafeFileExists(string path) {
    try { return !IsNetworkPath(path) && File.Exists(path); } catch { return false; }
  }

  private static bool IsIconSource(string path) =>
    path.EndsWith(".ico", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase);

  /// <summary>Pastas grandes demais para serem "a pasta de um programa" (Arquivos de Programas, AppData, a raiz de um disco...).</summary>
  internal static bool IsBroadFolder(string folder) {
    var f = folder.TrimEnd('\\');
    if (f.Length <= 2) return true;   // raiz de disco
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    var broad = new[] {
      Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
      Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
      local, Path.Combine(local, "Programs"), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
      Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
      Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.System),
    };
    return broad.Any(b => b.Length > 0 && string.Equals(b.TrimEnd('\\'), f, StringComparison.OrdinalIgnoreCase));
  }

  /// <summary>Tira a barra final de uma pasta ("C:\x\" vira "C:\x"), menos na raiz do disco.</summary>
  internal static string TrimDir(string dir) => dir.Length > 3 ? dir.TrimEnd('\\') : dir;

  /// <summary>Expande %VARIAVEIS%, tira aspas, troca / por \ e exige caminho completo. Tira o prefixo \\?\ ou \\.\ de caminhos comuns
  /// (C:\x e \\servidor\x; só mantém quando o caminho passa de 259 caracteres). null se não for um caminho válido ou se for um dispositivo
  /// (\\?\Volume{...}, \\.\pipe\...).</summary>
  internal static string? NormPath(string? raw) {
    if (string.IsNullOrWhiteSpace(raw)) return null;
    try {
      var s = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"').Trim()).Replace('/', '\\');
      if (s.Length == 0 || !Path.IsPathFullyQualified(s)) return null;
      var full = Path.GetFullPath(s);
      if (full.StartsWith(@"\\?\", StringComparison.Ordinal) || full.StartsWith(@"\\.\", StringComparison.Ordinal)) {
        var rest = full[4..];
        if (rest.StartsWith(@"UNC\", StringComparison.OrdinalIgnoreCase)) { var unc = @"\\" + rest[4..]; return unc.Length < 260 ? unc : full; }
        if (rest.Length >= 3 && char.IsAsciiLetter(rest[0]) && rest[1] == ':' && rest[2] == '\\') return rest.Length < 260 ? rest : full;
        return null;
      }
      return full;
    } catch {
      return null;
    }
  }

  /// <summary>O formato longo (\\?\C:\... ou \\?\UNC\servidor\...) que as APIs antigas do Windows exigem acima de MAX_PATH; caminhos curtos ficam como estão.</summary>
  internal static string LongPath(string path, int threshold = 250) {
    if (path.Length < threshold || path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
    return path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..] : @"\\?\" + path;
  }

  // ---------- Ícones ----------

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint PrivateExtractIcons(string szFileName, int nIconIndex, int cxIcon, int cyIcon, [Out] IntPtr[] phicon, [Out] int[]? piconid, uint nIcons, uint flags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DestroyIcon(IntPtr hIcon);

  /// <summary>Ícone 32x32 do arquivo (.exe, .ico, .dll) como PNG em base64; null se não houver ou falhar.</summary>
  internal static string? IconPng(string file, int index) {
    if (string.IsNullOrEmpty(file)) return null;
    try {
      // A data de gravação entra na chave: um programa atualizado (ícone novo) não fica preso ao ícone velho enquanto a janela está aberta.
      var key = file.ToLowerInvariant() + "|" + index + "|" + File.GetLastWriteTimeUtc(file).Ticks;
      return IconCache.GetOrAdd(key, _ => ExtractIcon(file, index));
    } catch {
      return null;
    }
  }

  private static string? ExtractIcon(string file, int index) {
    var handles = new IntPtr[1];
    try {
      if (!File.Exists(file)) return null;
      // A API só aceita MAX_PATH (260); acima disso tenta o formato longo e, se o Windows recusar, fica sem ícone.
      var name = LongPath(file, 259);
      var n = PrivateExtractIcons(name, index, 32, 32, handles, null, 1, 0);
      if (n == 0 || n == uint.MaxValue || handles[0] == IntPtr.Zero) return null;
      using var icon = Icon.FromHandle(handles[0]);
      using var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.Clear(Color.Transparent);
        g.DrawIcon(icon, new Rectangle(0, 0, 32, 32));
      }
      using var ms = new MemoryStream();
      bmp.Save(ms, ImageFormat.Png);
      return Convert.ToBase64String(ms.ToArray());
    } catch {
      return null;
    } finally {
      if (handles[0] != IntPtr.Zero) DestroyIcon(handles[0]);
    }
  }
}

/// <summary>Olha dentro de um arquivo (.exe, .lnk, .bat...) sem executá-lo: nome, empresa, versão, ícone, destino do atalho.</summary>
internal static class ProgramInspector {
  private static readonly string[] GenericProduct = {
    "operating system", "sistema operacional", "unknown", "desconhecido", "application", "aplicativo", "aplicacao", "win32 application",
    "n/a", "none", "launcher", "game", "jogo", "app", "setup", "installer", "executable", "executavel",
  };
  // Subpastas técnicas por onde um .exe costuma ficar (bin\x64, Release...): o nome do programa é o da pasta acima delas.
  private static readonly HashSet<string> TechnicalFolders = new(StringComparer.Ordinal) {
    "bin", "bin32", "bin64", "x64", "x86", "win64", "win32", "binaries", "release", "debug", "app", "application", "game", "client", "build", "dist", "windows", "windowsnoeditor",
  };
  // Pastas que só guardam coisas de outras pessoas (Downloads, Jogos, Microsoft\WindowsApps...): nunca são o nome de um programa.
  private static readonly HashSet<string> ContainerFolders = new(StringComparer.Ordinal) {
    "program files", "program files (x86)", "programs", "programas", "windowsapps", "downloads", "transferencias", "desktop", "area de trabalho", "documents", "documentos", "my documents",
    "games", "jogos", "tools", "ferramentas", "content", "microsoft", "local", "locallow", "roaming", "appdata", "users", "usuarios", "public", "temp", "tmp", "common", "steamapps",
    "apps", "applications", "aplicativos", "server", "servers", "system32", "syswow64",
  };
  private static readonly Regex GenericScript = new(@"^(start|run|launch|launcher|play|game|jogar|iniciar|abrir|executar|open|main|go|app|init|exec)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
  private static readonly Regex GenericShortcut = new(@"^(atalho|shortcut|novo atalho|new shortcut|link|programa|aplicativo|application)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
  private static readonly Regex CamelRx = new(@"^(?:[A-Z][a-z0-9]+){3,}$", RegexOptions.CultureInvariant);
  private static readonly Regex DottedRx = new(@"^\S+(\.\S+){2,}$", RegexOptions.CultureInvariant);   // "Application.NDI.Bridge.UI": nome de assembly, não de programa
  private static readonly TextInfo EnUs = CultureInfo.GetCultureInfo("en-US").TextInfo;

  /// <summary>Resposta do comando "inspectProgram". Nunca lança.</summary>
  public static async Task<JsonObject> InspectAsync(string? path) {
    try {
      var task = Task.Run(() => Inspect(path));
      if (await Task.WhenAny(task, Task.Delay(10000)) != task) return Fail("O Windows demorou demais para responder (o disco ou a rede pode estar lento). Tente de novo.");
      return await task;
    } catch (Exception) {
      return Fail("Não consegui ler esse arquivo.");
    }
  }

  private static JsonObject Fail(string error, bool folder = false) {
    var o = new JsonObject { ["ok"] = false, ["error"] = error };
    if (folder) o["isFolder"] = true;
    return o;
  }

  public static JsonObject Inspect(string? rawPath) {
    try {
      var path = ProgramScanner.NormPath(rawPath);
      if (path == null) return string.IsNullOrWhiteSpace(rawPath) ? Fail("Nenhum arquivo foi escolhido.") : Fail("Esse caminho não é válido. Escolha o arquivo do programa de novo.");
      if (Directory.Exists(path)) return Fail("Isso é uma pasta, e não um programa. Escolha o arquivo do programa (.exe) que fica dentro dela.", folder: true);
      if (!File.Exists(path)) return Fail("Não encontrei esse arquivo. Ele pode ter sido movido, apagado ou estar em um disco que não está conectado.");

      var ext = Path.GetExtension(path).ToLowerInvariant();
      return ext switch {
        ".exe" => InspectExe(path, "exe", "", Path.GetDirectoryName(path) ?? "", null, null, 0, null),
        ".lnk" => InspectLink(path),
        ".bat" or ".cmd" => InspectScript(path),
        _ => InspectOther(path),
      };
    } catch (UnauthorizedAccessException) {
      return Fail("O Windows não deixou ler esse arquivo (sem permissão).");
    } catch (PathTooLongException) {
      return Fail("O caminho desse arquivo é longo demais para o Windows. Mova o programa para uma pasta mais curta.");
    } catch (IOException) {
      return Fail("Não consegui ler esse arquivo. Ele pode estar em uso, em um disco desconectado ou na rede.");
    } catch (Exception) {
      return Fail("Não consegui ler esse arquivo.");
    }
  }

  /// <param name="infoExe">De onde ler os dados do programa (nome, empresa, versão), quando não é o próprio <paramref name="exe"/> (atalho Squirrel: Update.exe).</param>
  private static JsonObject InspectExe(string exe, string kind, string args, string dir, string? shortcutName, string? iconFile, int iconIndex, string? infoExe) {
    if (!LooksLikeProgram(exe)) return Fail("Esse arquivo tem a extensão .exe, mas não parece ser um programa do Windows.");
    var info = infoExe ?? exe;
    var (product, description, company, version) = ReadVersion(info);
    // Num atalho, o nome que a pessoa deu a ele ("Word", "Servidor Minecraft") vale mais do que o do programa de destino
    // (que é o mesmo para vários atalhos: "Microsoft Office", "Java(TM) Platform SE 8"); é o mesmo nome que a lista de instalados mostra.
    var linkName = kind == "lnk" ? UsefulShortcutName(shortcutName) : null;
    var name = linkName ?? ProgramFilters.StripLauncher(ProgramFilters.CleanName(PickName(product, description, Path.GetFileNameWithoutExtension(info), company) ?? FallbackName(info)));
    var icon = ProgramScanner.IconPng(iconFile ?? info, iconFile == null ? 0 : iconIndex) ?? (iconFile != null ? ProgramScanner.IconPng(info, 0) : null);
    var o = new JsonObject {
      ["ok"] = true, ["kind"] = kind, ["path"] = exe, ["args"] = args, ["dir"] = dir, ["name"] = name,
      ["product"] = product, ["description"] = description, ["company"] = company, ["version"] = version, ["icon"] = icon,
    };
    if (kind == "lnk") o["shortcutName"] = linkName ?? "";
    return o;
  }

  private static JsonObject InspectLink(string lnk) {
    var link = ShellLinks.RunSta(() => ShellLinks.Read(lnk), 8000);
    if (link == null) return Fail("Não consegui ler esse atalho. O arquivo pode estar danificado.");
    var target = link.Target;
    if (string.IsNullOrWhiteSpace(target) || target.Contains(@"\Windows\Installer\", StringComparison.OrdinalIgnoreCase)) {
      target = ShellLinks.RunSta(() => ShellLinks.ResolveAdvertised(lnk), 8000) ?? target;
    }
    var exe = ProgramScanner.NormPath(target);
    if (exe == null) return Fail("Esse atalho não abre um programa comum (pode ser um atalho para uma pasta, um site ou um aplicativo da Microsoft Store). Escolha o arquivo .exe do programa.");
    if (Directory.Exists(exe)) return Fail("Esse atalho abre uma pasta, e não um programa. Escolha o arquivo .exe do programa.");
    if (!File.Exists(exe)) return Fail($"Esse atalho está quebrado: o programa que ele abre não existe mais ({exe}).");
    if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return Fail("Esse atalho abre um arquivo que não é um programa (.exe). Escolha o .exe do programa.");
    var args = link.Args.Trim();
    string? infoExe = null;
    if (ProgramScanner.TrySquirrel(exe, args, out var sq)) { exe = sq.Exe; args = sq.Args; infoExe = sq.IconExe; }
    var dir = ProgramScanner.ChooseWorkDir(link.WorkDir, exe);
    var iconPath = ProgramScanner.NormPath(link.IconPath);
    var useLinkIcon = iconPath != null && !ProgramScanner.IsNetworkPath(iconPath) && File.Exists(iconPath) && !ProgramFilters.IsJunkPath(iconPath) && (iconPath.EndsWith(".ico", StringComparison.OrdinalIgnoreCase) || iconPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || iconPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase));
    return InspectExe(exe, "lnk", args, dir, Path.GetFileNameWithoutExtension(lnk), useLinkIcon ? iconPath : null, link.IconIndex, infoExe);
  }

  private static JsonObject InspectScript(string file) {
    var dir = Path.GetDirectoryName(file) ?? "";
    var baseName = Path.GetFileNameWithoutExtension(file);
    var name = GenericScript.IsMatch(baseName) ? FolderName(file) ?? baseName : baseName.Replace('_', ' ').Trim();
    return new JsonObject {
      ["ok"] = true, ["kind"] = "bat", ["path"] = file, ["args"] = "", ["dir"] = dir, ["name"] = ProgramFilters.CleanName(name),
      ["product"] = "", ["description"] = "", ["company"] = "", ["version"] = "", ["icon"] = null,
    };
  }

  private static JsonObject InspectOther(string file) {
    var dir = Path.GetDirectoryName(file) ?? "";
    return new JsonObject {
      ["ok"] = true, ["kind"] = "other", ["path"] = file, ["args"] = "", ["dir"] = dir, ["name"] = ProgramFilters.CleanName(Path.GetFileNameWithoutExtension(file).Replace('_', ' ')),
      ["product"] = "", ["description"] = "", ["company"] = "", ["version"] = "", ["icon"] = null,
    };
  }

  /// <summary>Os dois primeiros bytes de um programa do Windows são "MZ". Sem permissão de leitura, não dá para saber: deixa passar.</summary>
  private static bool LooksLikeProgram(string exe) {
    try {
      using var fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
      return fs.ReadByte() == 'M' && fs.ReadByte() == 'Z';
    } catch (UnauthorizedAccessException) {
      return true;
    } catch (IOException) {
      return true;
    }
  }

  /// <summary>ProductName, FileDescription, CompanyName e FileVersion do .exe (vazios quando não existem, não dá para ler ou o recurso de versão está corrompido).</summary>
  internal static (string Product, string Description, string Company, string Version) ReadVersion(string exe) {
    try {
      // Caminho acima de 259 caracteres: a API de versão só aceita o formato longo (\\?\C:\... ou \\?\UNC\servidor\...).
      var v = FileVersionInfo.GetVersionInfo(ProgramScanner.LongPath(exe));
      var version = ValidVersion(v.FileVersion) ?? ValidVersion(v.ProductVersion);
      if (version == null && (v.FileMajorPart | v.FileMinorPart | v.FileBuildPart) != 0) version = $"{v.FileMajorPart}.{v.FileMinorPart}.{v.FileBuildPart}.{v.FilePrivatePart}";
      return (Tidy(v.ProductName), Tidy(v.FileDescription), Tidy(v.CompanyName), version ?? "");
    } catch {
      return ("", "", "", "");
    }
  }

  /// <summary>"1.2.3.4", "1, 2, 3, 4" ou "1.2.3.4 (build 55)" viram "1.2.3.4"; texto que não começa por número (recurso corrompido) vira null.</summary>
  private static string? ValidVersion(string? raw) {
    var s = Tidy(raw);
    if (s.Length == 0) return null;
    s = Regex.Replace(s, @"\s*,\s*", ".");
    var m = Regex.Match(s, @"^\d+(\.\d+)*");
    if (!m.Success) return null;
    return m.Value.Length > 40 ? m.Value[..40] : m.Value;
  }

  /// <summary>Texto de um recurso de versão, sem espaços sobrando. Com caractere de controle ou de substituição no meio (recurso corrompido), é "".</summary>
  private static string Tidy(string? s) {
    if (string.IsNullOrEmpty(s)) return "";
    var t = s.Replace('\0', ' ');
    foreach (var ch in t) {
      if ((char.IsControl(ch) && !char.IsWhiteSpace(ch)) || ch == '\uFFFD') return "";
    }
    return Regex.Replace(t, @"\s+", " ").Trim();
  }

  /// <summary>Nome do atalho sem o que o Windows acrescenta ("Hades - Atalho", "Atalho para Hades"); null se sobrar um nome genérico ("Atalho", "start").</summary>
  internal static string? UsefulShortcutName(string? raw) {
    var s = (raw ?? "").Trim();
    const RegexOptions ic = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    s = Regex.Replace(s, @"^(atalho para|atalho de|shortcut to)\s+", "", ic);
    s = Regex.Replace(s, @"\s*[-–—]\s*(atalho|shortcut)(\s*\(\d+\))?$", "", ic);
    s = Regex.Replace(s, @"\s*\((atalho|shortcut)\)$", "", ic).Trim();
    if (s.Length < 2 || !s.Any(char.IsLetterOrDigit)) return null;
    return GenericShortcut.IsMatch(ProgramFilters.Fold(s)) || GenericScript.IsMatch(s) ? null : s;
  }

  /// <summary>Nome útil entre ProductName e FileDescription (ignora os genéricos, tipo "Microsoft® Windows® Operating System").
  /// Entre os dois, fica o que mais lembra o nome do arquivo (WINWORD.EXE: "Microsoft Word" e não "Microsoft Office"); no empate, o ProductName,
  /// a não ser que ele seja só o nome da empresa.</summary>
  internal static string? PickName(string product, string description, string exeBase = "", string company = "") {
    var cands = new List<string>();
    if (IsUseful(product)) cands.Add(product);
    if (IsUseful(description) && description.Length <= 60 && !cands.Contains(description, StringComparer.OrdinalIgnoreCase)) cands.Add(description);
    if (cands.Count == 0) return null;
    var best = cands[0];
    if (cands.Count == 2) {
      var sp = NameScore(exeBase, cands[0]);
      var sd = NameScore(exeBase, cands[1]);
      if (sd > sp || (sd == sp && IsCompanyName(cands[0], company) && !IsCompanyName(cands[1], company))) best = cands[1];
    }
    return SplitCamel(best);
  }

  private static int NameScore(string exeBase, string text) {
    var s = FilePicker.Similarity(exeBase, text);
    return s < 30 && IsAbbreviation(exeBase, text) ? 35 : s;
  }

  /// <summary>O nome do .exe é uma abreviação de uma palavra do texto ("powerpnt" e "PowerPoint").</summary>
  private static bool IsAbbreviation(string exeBase, string text) {
    var e = FilePicker.Alnum(FilePicker.StripNoise(exeBase));
    if (e.Length < 5) return false;
    foreach (var word in Regex.Split(ProgramFilters.Fold(text), @"[^\p{L}\p{N}]+")) {
      if (word.Length < 5 || word[0] != e[0]) continue;
      var i = 0;
      foreach (var ch in word) if (i < e.Length && ch == e[i]) i++;
      if (i == e.Length) return true;
    }
    return false;
  }

  private static bool IsCompanyName(string text, string company) {
    var t = FilePicker.Alnum(text);
    var c = FilePicker.Alnum(Regex.Replace(company, @"\b(inc|corp|corporation|ltd|llc|gmbh|co|sa|ltda|limited)\b\.?", "", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
    return t.Length >= 3 && c.Length >= 3 && (t == c || (t.Length >= 4 && c.Contains(t, StringComparison.Ordinal)));
  }

  private static bool IsUseful(string s) {
    if (string.IsNullOrWhiteSpace(s) || s.Trim().Length < 2) return false;
    var f = ProgramFilters.Fold(s).Trim();
    if (f.EndsWith(".exe", StringComparison.Ordinal) || GenericProduct.Any(g => f == g || f.Contains("operating system", StringComparison.Ordinal))) return false;
    if (DottedRx.IsMatch(s.Trim()) || Regex.IsMatch(f, @"^[\d.\s]+$")) return false;
    return !ProgramFilters.IsJunkName(s) && f.Any(char.IsLetterOrDigit);
  }

  /// <summary>"EpicGamesLauncher" (três ou mais palavras coladas, sem espaço) vira "Epic Games Launcher"; "GitHub" e "Discord" ficam como estão.</summary>
  private static string SplitCamel(string s) => CamelRx.IsMatch(s) ? Regex.Replace(s, @"(?<=[a-z0-9])(?=[A-Z])", " ") : s;

  /// <summary>Nome para um .exe sem ProductName/FileDescription úteis: o do arquivo ("hollow_knight.exe" vira "Hollow Knight"), a não ser que o arquivo tenha nome
  /// genérico (launcher, start, game...): aí vale o da pasta do programa. Pastas como Downloads, Jogos e WindowsApps nunca viram nome.</summary>
  internal static string FallbackName(string exe) {
    var fileBase = Path.GetFileNameWithoutExtension(exe);
    var words = Humanize(fileBase);
    var folder = FolderName(exe);
    if (folder == null) return words;
    if (GenericScript.IsMatch(fileBase) || FilePicker.Alnum(folder) == FilePicker.Alnum(words)) return folder;   // (mesmas letras: a pasta costuma estar mais bem escrita)
    return words;
  }

  /// <summary>"RobloxPlayerBeta" vira "Roblox Player Beta", "Game-Win64-Shipping" vira "Game", "hollow_knight" vira "Hollow Knight".</summary>
  private static string Humanize(string fileBase) {
    var s = FilePicker.StripNoise(fileBase).Trim();
    if (s.Length < 2) s = fileBase.Trim();
    if (s.IndexOfAny(new[] { '_', '-' }) >= 0) s = Regex.Replace(s, @"[_\-]+", " ").Trim();
    else s = SplitCamel(s);
    if (s.Length > 3 && !s.Any(char.IsUpper)) s = EnUs.ToTitleCase(s);
    return s.Length == 0 ? fileBase : s;
  }

  /// <summary>Nome da pasta do programa, subindo só pelas subpastas técnicas (bin, x64, Release...); null se a pasta é só um recipiente (Downloads, Jogos, WindowsApps...).</summary>
  private static string? FolderName(string file) {
    var dir = Path.GetDirectoryName(file);
    for (var i = 0; i < 4 && !string.IsNullOrEmpty(dir); i++) {
      var n = Path.GetFileName(dir);
      if (string.IsNullOrEmpty(n)) return null;
      var f = ProgramFilters.Fold(n);
      if (ContainerFolders.Contains(f)) return null;
      if (!TechnicalFolders.Contains(f)) return n;
      dir = Path.GetDirectoryName(dir);
    }
    return null;
  }
}
