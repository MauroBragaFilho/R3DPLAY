"""Gera a logo "R" do R3D (variação A, refinada) em SVG, PNG e ICO.

A geometria vem de gerar_svg.py (única fonte da verdade): o mesmo "R" do ícone do celular, em unidades do quadro 108 x 108.
Aqui a letra é rasterizada com PIL usando juntas VIVAS (miter), iguais às do SVG: contorno vermelho centrado no caminho,
miolo escuro e contraforma vazada. O fundo é o gradiente radial escuro-avermelhado do ícone.
Uso: python gerar_logo.py   (grava r3d-logo.svg, r3d-r.svg, PNGs e r3d.ico ao lado deste script)
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw

import gerar_svg as G

AQUI = os.path.dirname(os.path.abspath(__file__))
RED = (227, 32, 44)       # #E3202C
INK = (5, 5, 6)           # #050506
STROKE = G.STROKE * G.SCALE   # espessura do contorno em unidades do quadro 108 (2,46)
MITER_LIMIT = 4.0


def parse_subpaths(d, passos=24):
    """Converte o caminho (M, L, C, Z absolutos) em listas de pontos no quadro 108 x 108."""
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
            for k in range(1, passos + 1):
                u = k / passos
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
    return subs


def dedupe(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 1e-6:
            out.append(p)
    if math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < 1e-6:
        out.pop()
    return out


def offset_polygon(pts, d):
    """Desloca um polígono fechado d unidades para FORA (d>0) ou para DENTRO (d<0) com juntas vivas (limite 4, como o SVG)."""
    pts = dedupe(pts)
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n)) / 2
    sign = 1.0 if area > 0 else -1.0     # em coordenadas de tela (y para baixo) a orientação define de que lado fica o "fora"
    out = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        e1 = (p1[0] - p0[0], p1[1] - p0[1])
        e2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        n1 = (sign * e1[1] / l1, -sign * e1[0] / l1)      # normal externa da aresta que chega
        n2 = (sign * e2[1] / l2, -sign * e2[0] / l2)      # normal externa da aresta que sai
        dot = n1[0] * n2[0] + n1[1] * n2[1]
        denom = 1.0 + dot
        if denom < 1e-9:
            out.append((p1[0] + n1[0] * d, p1[1] + n1[1] * d))
            continue
        mx, my = (n1[0] + n2[0]) / denom, (n1[1] + n2[1]) / denom
        ml = math.hypot(mx, my)
        if ml > MITER_LIMIT:                              # ponta fina demais: corta (bisel), como o SVG
            mx, my = mx / ml * MITER_LIMIT, my / ml * MITER_LIMIT
        out.append((p1[0] + mx * d, p1[1] + my * d))
    return out


def fundo_radial(n):
    """Gradiente radial de r3d_ic_background.xml (centro 54,116; raio 76 no quadro 108)."""
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
    outer, counter = parse_subpaths(G.mark_d('a'))[:2]
    k = big / 108.0
    zoom = 1.0 - margem * 2
    off = (1.0 - zoom) * 54.0

    def tr(pts):
        return [((x * zoom + off) * k, (y * zoom + off) * k) for x, y in pts]

    half = STROKE / 2 * zoom * k

    def mask(poly):
        m = Image.new("L", (big, big), 0)
        ImageDraw.Draw(m).polygon(poly, fill=255)
        return m

    outer_pts, counter_pts = tr(outer), tr(counter)
    o_exp, o_shr = mask(offset_polygon(outer_pts, half)), mask(offset_polygon(outer_pts, -half))
    c_exp, c_shr = mask(offset_polygon(counter_pts, half)), mask(offset_polygon(counter_pts, -half))
    # contorno = faixa em volta do perímetro externo + faixa em volta da contraforma; miolo = o que sobra no meio
    red = ImageChops.lighter(ImageChops.subtract(o_exp, o_shr), ImageChops.subtract(c_exp, c_shr))
    ink = ImageChops.subtract(o_shr, c_exp)

    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    layer.paste(Image.new("RGBA", (big, big), INK + (255,)), mask=ink)
    layer.paste(Image.new("RGBA", (big, big), RED + (255,)), mask=red)
    if com_fundo:
        out = fundo_radial(big // 8).resize((big, big)).convert("RGBA")
        out.alpha_composite(layer)
    else:
        out = layer
    return out.resize((n, n), Image.LANCZOS)


def svg(com_fundo):
    """SVG da logo: ícone quadrado com o fundo (True) ou só a marca transparente (False)."""
    with open(os.path.join(AQUI, 'svg', 'r3d-a-icone-quadrado.svg' if com_fundo else 'r3d-a-marca.svg'), encoding='utf-8') as f:
        return f.read()


if __name__ == "__main__":
    G.build()
    open(os.path.join(AQUI, "r3d-logo.svg"), "w", encoding="utf-8").write(svg(True))
    open(os.path.join(AQUI, "r3d-r.svg"), "w", encoding="utf-8").write(svg(False))
    render(512).save(os.path.join(AQUI, "r3d-logo-512.png"))
    render(256, margem=0.0).save(os.path.join(AQUI, "r3d-logo-256.png"))
    render(256, com_fundo=False).save(os.path.join(AQUI, "r3d-r-256.png"))
    icones = [render(s, margem=0.04) for s in (256, 128, 64, 48, 32, 24, 16)]
    icones[0].save(os.path.join(AQUI, "r3d.ico"), sizes=[(s, s) for s in (256, 128, 64, 48, 32, 24, 16)], append_images=icones[1:])
    print("ok")
