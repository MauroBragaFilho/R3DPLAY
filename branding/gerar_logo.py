"""Gera a logo "R" do R3D (a mesma do ícone do fork do RetroArch no celular) em SVG, PNG e ICO.

O vetor vem de RetroArch/pkg/android/phoenix/r3dcore/res/drawable/r3d_ic_foreground.xml (viewport 108x108,
grupo com escala 0.112 e deslocamento 9.42/10.6) e r3d_ic_background.xml (gradiente radial escuro-avermelhado).
Uso: python gerar_logo.py   (grava os arquivos ao lado deste script)
"""
import math
import os

from PIL import Image, ImageDraw

AQUI = os.path.dirname(os.path.abspath(__file__))

R_PATH = ("M180 200 L480 200 C562 200 612 252 612 328 C612 382 586 420 548 440 L616 575 L478 575 L420 468 L352 468 "
          "L336 575 L214 575 L214 478 L190 452 L190 365 L266 292 Z "
          "M372 305 L448 305 C472 305 488 320 488 340 C488 360 472 375 448 375 L405 375 Z")
SCALE, TX, TY = 0.112, 9.42, 10.6
STROKE_W = 22
RED = (227, 32, 44)       # #E3202C
INK = (5, 5, 6)           # #050506


def parse_subpaths(d):
    """Converte o caminho (M, L, C, Z absolutos) em listas de pontos no espaço 108x108."""
    for letra in "MLCZ":
        d = d.replace(letra, f" {letra} ")
    toks = d.replace(",", " ").split()
    subs, cur, i = [], [], 0
    px = py = 0.0
    while i < len(toks):
        t = toks[i]
        if t == "M":
            if cur:
                subs.append(cur)
            px, py = float(toks[i + 1]), float(toks[i + 2])
            cur = [(px, py)]
            i += 3
        elif t == "L":
            px, py = float(toks[i + 1]), float(toks[i + 2])
            cur.append((px, py))
            i += 3
        elif t == "C":
            x1, y1, x2, y2, x3, y3 = (float(v) for v in toks[i + 1:i + 7])
            for k in range(1, 17):
                u = k / 16
                a, b, c, e = (1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3
                cur.append((a * px + b * x1 + c * x2 + e * x3, a * py + b * y1 + c * y2 + e * y3))
            px, py = x3, y3
            i += 7
        elif t == "Z":
            i += 1
        else:
            raise ValueError(t)
    if cur:
        subs.append(cur)
    return [[(x * SCALE + TX, y * SCALE + TY) for x, y in s] for s in subs]


def fundo_radial(n):
    """Gradiente radial de r3d_ic_background.xml (centro 54,116; raio 76)."""
    img = Image.new("RGB", (n, n))
    px = img.load()
    stops = [(0.0, (0x5A, 0x0A, 0x10)), (0.45, (0x22, 0x06, 0x0A)), (1.0, (0x05, 0x05, 0x06))]
    for y in range(n):
        for x in range(n):
            vx, vy = (x + 0.5) / n * 108, (y + 0.5) / n * 108
            t = min(1.0, math.hypot(vx - 54, vy - 116) / 76)
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    k = (t - t0) / (t1 - t0)
                    px[x, y] = tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                    break
    return img


def render(n, com_fundo=True, ss=4, margem=0.0):
    """Desenha a logo em n x n px. margem (0..0.4) encolhe a letra para ícones que precisam de respiro."""
    big = n * ss
    subs = parse_subpaths(R_PATH)
    k = big / 108.0
    zoom = 1.0 - margem * 2
    off = (1.0 - zoom) * 54.0

    def tr(p):
        return ((p[0] * zoom + off) * k, (p[1] * zoom + off) * k)

    mask = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(mask)
    md.polygon([tr(p) for p in subs[0]], fill=255)
    md.polygon([tr(p) for p in subs[1]], fill=0)  # contraforma do R (even-odd)
    base = fundo_radial(big // 8).resize((big, big)) if com_fundo else None
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    layer.paste(Image.new("RGBA", (big, big), INK + (255,)), mask=mask)
    ld = ImageDraw.Draw(layer)
    w = max(1, int(STROKE_W * SCALE * zoom * k))
    for s in subs:
        pts = [tr(p) for p in s]
        ld.line(pts + [pts[0], pts[1]], fill=RED + (255,), width=w, joint="curve")
    if com_fundo:
        out = base.convert("RGBA")
        out.alpha_composite(layer)
    else:
        out = layer
    return out.resize((n, n), Image.LANCZOS)


def svg(com_fundo):
    fundo = ('<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="54" cy="116" r="76">'
             '<stop offset="0" stop-color="#5A0A10"/><stop offset="0.45" stop-color="#22060A"/>'
             '<stop offset="1" stop-color="#050506"/></radialGradient></defs>'
             '<rect width="108" height="108" fill="url(#g)"/>') if com_fundo else ""
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">' + fundo +
            f'<g transform="translate({TX} {TY}) scale({SCALE})">'
            f'<path fill="#050506" fill-rule="evenodd" stroke="#E3202C" stroke-width="{STROKE_W}" stroke-linejoin="miter" d="{R_PATH}"/>'
            '</g></svg>\n')


if __name__ == "__main__":
    open(os.path.join(AQUI, "r3d-logo.svg"), "w", encoding="utf-8").write(svg(True))
    open(os.path.join(AQUI, "r3d-r.svg"), "w", encoding="utf-8").write(svg(False))
    render(512).save(os.path.join(AQUI, "r3d-logo-512.png"))
    render(256, margem=0.0).save(os.path.join(AQUI, "r3d-logo-256.png"))
    render(256, com_fundo=False).save(os.path.join(AQUI, "r3d-r-256.png"))
    icones = [render(s, margem=0.04) for s in (256, 128, 64, 48, 32, 24, 16)]
    icones[0].save(os.path.join(AQUI, "r3d.ico"), sizes=[(s, s) for s in (256, 128, 64, 48, 32, 24, 16)], append_images=icones[1:])
    print("ok")
