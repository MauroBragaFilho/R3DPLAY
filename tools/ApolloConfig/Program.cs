using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ApolloConfig;

/// <summary>Fala com a API do Apollo (https://localhost) com sessão própria e login automático.</summary>
internal sealed class ApolloClient {
  private HttpClient http;
  private string baseUrl;
  private static readonly string CredFile = Path.Combine(DataDir, "cred.dat");

  public static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ApolloConfig");

  /// <summary>Pasta do WebView2 (cache da interface). R3D_WEBVIEW_DIR (só para testes) separa a de uma janela de desenvolvimento da instalada.</summary>
  public static string WebViewDir => Environment.GetEnvironmentVariable("R3D_WEBVIEW_DIR") is { Length: > 0 } d ? d : DataDir;

  public ApolloClient(string baseUrl) {
    this.baseUrl = baseUrl.TrimEnd('/');
    http = NewHttp();
  }

  private static HttpClient NewHttp() {
    var handler = new HttpClientHandler {
      CookieContainer = new CookieContainer(),
      AllowAutoRedirect = false,
      ServerCertificateCustomValidationCallback = (_, _, _, _) => true,  // certificado autoassinado em localhost
    };
    return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
  }

  /// <summary>O servidor voltou em outra porta (chave "port" do sunshine.conf): o painel web fica em porta + 1.</summary>
  public void Rebase(int port) {
    var url = $"https://localhost:{port + 1}";
    if (!string.Equals(url, baseUrl, StringComparison.OrdinalIgnoreCase)) baseUrl = url;
  }

  public string BaseUrl => baseUrl;

  /// <summary>Só o nome de usuário guardado (nunca a senha): a interface pré-preenche "usuário atual".</summary>
  public string? SavedUser() => LoadCredentials() is var (u, _) ? u : null;

  /// <summary>Descarta o cookie de sessão (sair da conta): o HttpClient guardaria o cookie antigo.</summary>
  public void ResetSession() {
    var old = http;
    http = NewHttp();
    old.Dispose();
  }

  /// <summary>O servidor declara windows-1252 no /api/logs, mas grava UTF-8: decodifica os bytes como UTF-8 e só cai no Latin-1 se não for válido.</summary>
  private static string Decode(byte[] raw) {
    try {
      return new UTF8Encoding(false, true).GetString(raw);
    } catch (DecoderFallbackException) {
      return Encoding.Latin1.GetString(raw);
    }
  }

  public bool HasCredentials => File.Exists(CredFile);

  public void SaveCredentials(string user, string pass) {
    Directory.CreateDirectory(DataDir);
    var raw = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new[] { user, pass }));
    File.WriteAllBytes(CredFile, ProtectedData.Protect(raw, null, DataProtectionScope.CurrentUser));
  }

  public void ClearCredentials() {
    if (File.Exists(CredFile)) File.Delete(CredFile);
  }

  private (string, string)? LoadCredentials() {
    try {
      var raw = ProtectedData.Unprotect(File.ReadAllBytes(CredFile), null, DataProtectionScope.CurrentUser);
      var a = JsonSerializer.Deserialize<string[]>(raw);
      return a is { Length: 2 } ? (a[0], a[1]) : null;
    } catch {
      return null;
    }
  }

  public async Task<bool> LoginAsync(string user, string pass) {
    var body = JsonSerializer.Serialize(new { username = user, password = pass });
    using var res = await http.PostAsync(baseUrl + "/api/login", new StringContent(body, Encoding.UTF8, "application/json"));
    return res.IsSuccessStatusCode;
  }

  public async Task<(int Status, string Body)> SendAsync(string method, string path, string? body) {
    for (var attempt = 0; attempt < 2; attempt++) {
      using var req = new HttpRequestMessage(new HttpMethod(method), baseUrl + path);
      // O servidor recusa POST sem Content-Type JSON (400), então todo método que não é GET leva ao menos {}.
      if (body == null && method != "GET" && method != "HEAD") body = "{}";
      if (body != null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
      HttpResponseMessage res;
      try {
        res = await http.SendAsync(req);
      } catch (Exception ex) {
        return (0, ex.Message);  // Apollo fora do ar
      }
      using (res) {
        var text = Decode(await res.Content.ReadAsByteArrayAsync());
        if (res.StatusCode == HttpStatusCode.Unauthorized && attempt == 0 && LoadCredentials() is var (u, p) && await LoginAsync(u, p)) {
          continue;  // sessão expirou: entrou de novo com a senha guardada
        }
        return ((int) res.StatusCode, text);
      }
    }
    return (401, "");
  }
}

/// <summary>Janela nativa do Apollo: interface própria (pasta ui) + ponte para a API.</summary>
internal sealed class MainForm : Form {
  private const string Title = "R3D PLAY";
  private const string UiHost = "r3dplay.local";
  private readonly WebView2 web = new() { Dock = DockStyle.Fill };
  private readonly string startUrl;
  private readonly ApolloClient api;
  private CoreWebView2Environment? env;

  public MainForm(string url) {
    startUrl = url;
    api = new ApolloClient(url);
    Text = Title;
    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    StartPosition = FormStartPosition.CenterScreen;
    Size = new Size(1280, 820);
    MinimumSize = new Size(900, 600);
    BackColor = Color.Black;
    Controls.Add(web);
    Load += async (_, _) => await InitAsync();
    FormClosing += async (_, e) => {
      // Fechar a janela com alterações não salvas numa tela (Configurações, Dispositivos): pergunta antes de perder.
      if (closeConfirmed || e.CloseReason != CloseReason.UserClosing || web.CoreWebView2 == null) return;
      e.Cancel = true;
      var dirty = false;
      try { dirty = await web.CoreWebView2.ExecuteScriptAsync("!!(window.__r3dDirty && window.__r3dDirty())") == "true"; } catch { /* página indisponível: fecha */ }
      if (dirty && MessageBox.Show(this, "Há alterações que ainda não foram salvas. Se fechar agora, elas serão perdidas." + Environment.NewLine + Environment.NewLine + "Fechar mesmo assim?", Title,
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
      closeConfirmed = true;
      Close();
    };
  }
  private bool closeConfirmed;

  private async Task InitAsync() {
    env = await CoreWebView2Environment.CreateAsync(null, ApolloClient.WebViewDir);
    await web.EnsureCoreWebView2Async(env);
    var core = web.CoreWebView2;
    core.Settings.AreDevToolsEnabled = false;
    core.Settings.AreDefaultContextMenusEnabled = false;
    core.Settings.IsStatusBarEnabled = false;
    core.SetVirtualHostNameToFolderMapping(UiHost, Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.Allow);
    core.NewWindowRequested += (_, e) => e.Handled = true;
    core.WebMessageReceived += async (_, e) => await OnMessageAsync(e.WebMessageAsJson);
    core.Navigate($"https://{UiHost}/index.html" + (Environment.GetEnvironmentVariable("R3D_TAB") is { Length: > 0 } t ? "#" + t : ""));
  }

  private async Task OnMessageAsync(string json) {
    var m = JsonNode.Parse(json)!;
    var id = m["id"]?.GetValue<int>() ?? 0;
    var cmd = m["cmd"]?.GetValue<string>();
    JsonNode result;
    try {
      switch (cmd) {
        case "api": {
          var (status, body) = await api.SendAsync(m["method"]!.GetValue<string>(), m["path"]!.GetValue<string>(), m["body"]?.GetValue<string>());
          result = new JsonObject { ["status"] = status, ["body"] = body };
          break;
        }
        case "login": {
          var user = m["user"]!.GetValue<string>();
          var pass = m["pass"]!.GetValue<string>();
          var ok = await api.LoginAsync(user, pass);
          if (ok) api.SaveCredentials(user, pass);
          result = new JsonObject { ["ok"] = ok };
          break;
        }
        case "logout":
          api.ClearCredentials();
          api.ResetSession();
          result = new JsonObject { ["ok"] = true };
          break;
        case "whoami":   // só o usuário (nunca a senha)
          result = new JsonObject { ["user"] = api.SavedUser() };
          break;
        case "rebase":   // o servidor mudou de porta: o painel web passa a ser porta + 1
          api.Rebase(m["port"]?.GetValue<int>() ?? 47989);
          result = new JsonObject { ["ok"] = true, ["url"] = api.BaseUrl };
          break;
        case "hasCreds":
          result = new JsonObject { ["ok"] = api.HasCredentials };
          break;
        case "scan": {
          var games = await Task.Run(GameScanner.ScanAll);
          var arr = new JsonArray();
          foreach (var g in games) arr.Add(new JsonObject { ["source"] = g.Source, ["id"] = g.Id, ["name"] = g.Name, ["uuid"] = g.Uuid, ["app"] = g.ToApp() });
          result = new JsonObject { ["games"] = arr };
          break;
        }
        case "log":  // diagnóstico da interface (arquivo ui.log na pasta de dados)
          File.AppendAllText(Path.Combine(ApolloClient.DataDir, "ui.log"), $"{DateTime.Now:HH:mm:ss} {m["text"]}{Environment.NewLine}");
          result = new JsonObject { ["ok"] = true };
          break;
        case "readCover": {  // lê um PNG da pasta de capas do Apollo (só arquivos .png dentro de uma pasta "covers")
          var path = Path.GetFullPath(m["path"]!.GetValue<string>());
          var ok = path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
            && string.Equals(Path.GetFileName(Path.GetDirectoryName(path)), "covers", StringComparison.OrdinalIgnoreCase) && File.Exists(path);
          result = new JsonObject { ["data"] = ok ? Convert.ToBase64String(await File.ReadAllBytesAsync(path)) : null };
          break;
        }
        case "cover": {
          var png = await CoverFetcher.GetPngAsync(m["source"]!.GetValue<string>(), m["gameId"]!.GetValue<string>(), m["name"]!.GetValue<string>());
          result = new JsonObject { ["data"] = png == null ? null : Convert.ToBase64String(png) };
          break;
        }
        case "stats": {  // uso do PC (CPU, RAM, GPU, discos, FPS): endpoint HTTP aberto à rede local, sem senha
          using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
          var port = m["port"]?.GetValue<int>() ?? 47989;
          try {
            result = new JsonObject { ["ok"] = true, ["body"] = await http.GetStringAsync($"http://localhost:{port}/r3d/stats") };
          } catch (Exception ex) {
            result = new JsonObject { ["ok"] = false, ["error"] = ex.Message };
          }
          break;
        }
        case "info":
          result = new JsonObject { ["host"] = Environment.MachineName, ["ips"] = LocalAddresses(), ["url"] = api.BaseUrl, ["dataDir"] = ApolloClient.DataDir };
          break;
        case "advanced":
          OpenAdvanced();
          result = new JsonObject { ["ok"] = true };
          break;
        default:
          result = new JsonObject { ["error"] = "comando desconhecido" };
          break;
      }
    } catch (Exception ex) {
      result = new JsonObject { ["error"] = ex.Message };
    }
    result["id"] = id;
    web.CoreWebView2.PostWebMessageAsString(result.ToJsonString());
  }

  private static JsonArray LocalAddresses() {
    var list = new JsonArray();
    foreach (var nic in NetworkInterface.GetAllNetworkInterfaces()) {
      if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
      var desc = nic.Description + " " + nic.Name;
      if (desc.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) || desc.Contains("VMware", StringComparison.OrdinalIgnoreCase) || desc.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase) || desc.Contains("vEthernet", StringComparison.OrdinalIgnoreCase)) continue;
      foreach (var ua in nic.GetIPProperties().UnicastAddresses) {
        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
        var b = ua.Address.GetAddressBytes();
        if (b[0] == 169 && b[1] == 254) continue;  // endereço automático, não serve para conectar
        var kind = b[0] == 100 && b[1] is >= 64 and <= 127 ? "tailscale" : b[0] == 26 ? "vpn" : nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? "wifi" : "lan";
        list.Add(new JsonObject { ["name"] = nic.Name, ["ip"] = ua.Address.ToString(), ["kind"] = kind });
      }
    }
    return list;
  }

  /// <summary>Painel original do Apollo (todas as opções avançadas) em uma janela própria.</summary>
  private void OpenAdvanced() {
    var form = new Form { Text = $"{Title} – Avançado", Size = new Size(1200, 800), StartPosition = FormStartPosition.CenterParent, Icon = Icon };
    var view = new WebView2 { Dock = DockStyle.Fill };
    form.Controls.Add(view);
    form.Load += async (_, _) => {
      var opts = new CoreWebView2EnvironmentOptions("--ignore-certificate-errors");
      var e2 = await CoreWebView2Environment.CreateAsync(null, Path.Combine(ApolloClient.DataDir, "advanced"), opts);
      await view.EnsureCoreWebView2Async(e2);
      view.CoreWebView2.NewWindowRequested += (_, a) => { a.Handled = true; view.CoreWebView2.Navigate(a.Uri); };
      view.CoreWebView2.Navigate(startUrl);
    };
    form.Show(this);
  }
}

internal static class Program {
  [STAThread]
  private static void Main(string[] args) {
    if (args.Length == 2 && args[0] == "--scan") {  // diagnóstico: grava os jogos detectados em um arquivo
      File.WriteAllLines(args[1], GameScanner.ScanAll().Select(g => $"{g.Source}\t{g.Name}\t{g.Detached ?? g.Cmd}"));
      return;
    }
    if (args.Length == 3 && args[0] == "--save-login") {  // guarda o login (criptografado, só para este usuário do Windows)
      new ApolloClient("https://localhost:47990").SaveCredentials(args[1], args[2]);
      return;
    }
    if (args.Length == 4 && args[0] == "--cover") {  // diagnóstico: baixa uma capa para um arquivo PNG
      var png = CoverFetcher.GetPngAsync(args[1], args[2], args[2]).GetAwaiter().GetResult();
      File.WriteAllText(args[3] + ".txt", png == null ? "sem capa" : png.Length + " bytes");
      if (png != null) File.WriteAllBytes(args[3], png);
      return;
    }
    if (args.Length == 2 && args[0] == "--close-dir") {  // fecha os processos de um jogo (usado pelo "undo" do Apollo)
      Environment.ExitCode = GameCloser.CloseProcessesIn(args[1]);
      return;
    }
    if (args.Length == 3 && args[0] == "--launch-steam") {  // abre um jogo da Steam na resolução do celular
      Environment.ExitCode = SteamLauncher.Launch(args[1], args[2]);
      return;
    }
    // R3D_ALLOW_MULTI=1 (só para testes de desenvolvimento) deixa abrir uma segunda janela ao lado da que já está aberta.
    using var mutex = new Mutex(true, Environment.GetEnvironmentVariable("R3D_ALLOW_MULTI") == "1" ? "ApolloConfigWindow-dev" : "ApolloConfigWindow", out var first);
    if (!first) return;  // já aberto
    var url = args.Length > 0 ? args[0] : "https://localhost:47990";
    ApplicationConfiguration.Initialize();
    Application.Run(new MainForm(url));
  }
}
