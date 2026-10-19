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
    Load += async (_, _) => await InitAsync();
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
      }
    };
    core.Navigate(startUrl);
  }
}

internal static class Program {
  [STAThread]
  private static void Main(string[] args) {
    using var mutex = new Mutex(true, "ApolloConfigWindow", out var first);
    var url = args.Length > 0 ? args[0] : "https://localhost:47990";
    if (!first) {
      return;  // já aberto; o Windows traz a janela existente via tray/foco
    }
    ApplicationConfiguration.Initialize();
    Application.Run(new MainForm(url));
  }
}
