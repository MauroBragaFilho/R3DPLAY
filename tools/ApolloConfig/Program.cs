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
  private readonly HttpClient http;
  private readonly string baseUrl;
  private static readonly string CredFile = Path.Combine(DataDir, "cred.dat");

  public static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ApolloConfig");

  public ApolloClient(string baseUrl) {
    this.baseUrl = baseUrl.TrimEnd('/');
    var handler = new HttpClientHandler {
      CookieContainer = new CookieContainer(),
      AllowAutoRedirect = false,
      ServerCertificateCustomValidationCallback = (_, _, _, _) => true,  // certificado autoassinado em localhost
    };
    http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
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
      if (body != null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
      HttpResponseMessage res;
      try {
        res = await http.SendAsync(req);
      } catch (Exception ex) {
        return (0, ex.Message);  // Apollo fora do ar
      }
      using (res) {
        var text = await res.Content.ReadAsStringAsync();
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
  }

  private async Task InitAsync() {
    env = await CoreWebView2Environment.CreateAsync(null, ApolloClient.DataDir);
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
          result = new JsonObject { ["ok"] = true };
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
        case "info":
          result = new JsonObject { ["host"] = Environment.MachineName, ["ips"] = LocalAddresses(), ["url"] = startUrl };
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
    using var mutex = new Mutex(true, "ApolloConfigWindow", out var first);
    if (!first) return;  // já aberto
    var url = args.Length > 0 ? args[0] : "https://localhost:47990";
    ApplicationConfiguration.Initialize();
    Application.Run(new MainForm(url));
  }
}
