using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Text.Json.Nodes;

namespace ApolloConfig;

/// <summary>Baixa a capa (retrato 2:3) de um jogo e devolve um PNG pequeno. Usa a CDN da Steam; jogos de outras lojas
/// são casados pelo nome exato na busca da Steam.</summary>
internal static class CoverFetcher {
  private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
  private const int W = 300, H = 450;

  public static async Task<byte[]?> GetPngAsync(string source, string id, string name) {
    var steamId = source == "steam" ? id : await FindSteamIdAsync(name);
    if (steamId == null) return null;
    var cdn = $"https://cdn.cloudflare.steamstatic.com/steam/apps/{steamId}";
    var raw = await TryGet($"{cdn}/library_600x900.jpg") ?? await TryGet($"{cdn}/library_600x900_2x.jpg");
    var crop = false;
    if (raw == null) { raw = await TryGet($"{cdn}/header.jpg"); crop = true; }  // sem retrato: recorta o centro do banner
    return raw == null ? null : ToPng(raw, crop);
  }

  private static async Task<byte[]?> TryGet(string url) {
    try {
      using var res = await Http.GetAsync(url);
      return res.IsSuccessStatusCode ? await res.Content.ReadAsByteArrayAsync() : null;
    } catch { return null; }
  }

  private static async Task<string?> FindSteamIdAsync(string name) {
    try {
      var json = await Http.GetStringAsync($"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(name)}&cc=br&l=portuguese");
      var items = JsonNode.Parse(json)?["items"]?.AsArray();
      static string Norm(string s) => new string(s.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
      var hit = items?.FirstOrDefault(i => i?["name"] is JsonNode n && Norm(n.GetValue<string>()) == Norm(name));
      return hit?["id"]?.ToString();
    } catch { return null; }
  }

  private static byte[] ToPng(byte[] data, bool cropCenter) {
    using var src = Image.FromStream(new MemoryStream(data));
    using var dst = new Bitmap(W, H);
    using (var g = Graphics.FromImage(dst)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      var srcH = src.Height;
      var srcW = cropCenter ? (int) (src.Height * (double) W / H) : src.Width;
      var x = (src.Width - srcW) / 2;
      g.DrawImage(src, new Rectangle(0, 0, W, H), new Rectangle(Math.Max(0, x), 0, Math.Min(srcW, src.Width), srcH), GraphicsUnit.Pixel);
    }
    using var ms = new MemoryStream();
    dst.Save(ms, ImageFormat.Png);
    return ms.ToArray();
  }
}
