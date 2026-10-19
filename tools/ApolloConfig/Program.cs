using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ApolloConfig;

/// <summary>Janela nativa que hospeda a interface de configuração do Apollo (sem navegador externo).</summary>
internal sealed class MainForm : Form {
  private const string Title = "Apollo";
  private readonly WebView2 web = new() { Dock = DockStyle.Fill };
  private readonly string startUrl;

  public MainForm(string url) {
    startUrl = url;
    Text = Title;
    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    StartPosition = FormStartPosition.CenterScreen;
    Size = new Size(1280, 860);
    MinimumSize = new Size(480, 600);
    Controls.Add(web);
    var menu = new MenuStrip();
    var detect = new ToolStripMenuItem("Detectar jogos");
    detect.Click += async (_, _) => await SyncGamesAsync(true);
    var reload = new ToolStripMenuItem("Recarregar");
    reload.Click += (_, _) => web.CoreWebView2?.Reload();
    menu.Items.AddRange(new ToolStripItem[] { detect, reload });
    Controls.Add(menu);
    MainMenuStrip = menu;
    Load += async (_, _) => await InitAsync();
  }

  private bool synced;

  /// <summary>Adiciona ao Apollo os jogos detectados que ainda não estão em apps.json (usa a sessão já logada da janela).</summary>
  private async Task SyncGamesAsync(bool manual) {
    var core = web.CoreWebView2;
    if (core == null) return;
    var games = await Task.Run(GameScanner.ScanAll);
    var raw = await core.ExecuteScriptAsync("fetch('/api/apps',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).catch(()=>null)");
    var existing = JsonNode.Parse(raw)?["apps"]?.AsArray();
    if (existing == null) {
      if (manual) MessageBox.Show(this, "Faça login primeiro e tente novamente.", Title);
      return;  // ainda não autenticado; tenta de novo na próxima navegação
    }
    synced = true;
    var have = existing.Select(a => a?["uuid"]?.GetValue<string>()).ToHashSet();
    var added = 0;
    foreach (var g in games.Where(g => !have.Contains(g.Uuid))) {
      var body = JsonSerializer.Serialize(g.ToApp().ToJsonString());
      var res = await core.ExecuteScriptAsync($"fetch('/api/apps',{{method:'POST',credentials:'same-origin',headers:{{'Content-Type':'application/json'}},body:{body}}}).then(r=>r.ok)");
      if (res == "true") added++;
    }
    if (added > 0) core.Reload();
    if (manual) MessageBox.Show(this, $"{games.Count} jogos encontrados, {added} novos adicionados.", Title);
  }

  private async Task InitAsync() {
    var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ApolloConfig");
    // Apollo usa certificado autoassinado em localhost.
    var opts = new CoreWebView2EnvironmentOptions("--ignore-certificate-errors");
    var env = await CoreWebView2Environment.CreateAsync(null, dataDir, opts);
    await web.EnsureCoreWebView2Async(env);
    var core = web.CoreWebView2;
    core.Settings.AreDevToolsEnabled = false;
    core.Settings.AreDefaultContextMenusEnabled = false;
    core.NewWindowRequested += (_, e) => { e.Handled = true; core.Navigate(e.Uri); };
    core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrEmpty(core.DocumentTitle) ? Title : $"{core.DocumentTitle} – {Title}";
    core.NavigationCompleted += async (_, e) => {
      if (!e.IsSuccess) {
        await Task.Delay(1500);
        core.Navigate(startUrl);  // servidor ainda iniciando
      } else if (!synced) {
        await SyncGamesAsync(false);
      }
    };
    core.Navigate(startUrl);
  }
}

internal static class Program {
  [STAThread]
  private static void Main(string[] args) {
    if (args.Length == 2 && args[0] == "--scan") {  // diagnóstico: grava os jogos detectados em um arquivo
      File.WriteAllLines(args[1], GameScanner.ScanAll().Select(g => $"{g.Source}	{g.Name}	{g.Detached ?? g.Cmd}"));
      return;
    }
    using var mutex = new Mutex(true, "ApolloConfigWindow", out var first);
    var url = args.Length > 0 ? args[0] : "https://localhost:47990";
    if (!first) {
      return;  // já aberto; o Windows traz a janela existente via tray/foco
    }
    ApplicationConfiguration.Initialize();
    Application.Run(new MainForm(url));
  }
}
