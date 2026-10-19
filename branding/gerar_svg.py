"""Kit de logos SVG do R3D (o "R" do R3D LAUNCHER), refeito com geometria limpa.

A marca é a mesma letra "R" angular do ícone do celular (fork do RetroArch), mas construída por pontos com regras
explícitas, em vez de herdar os números soltos do vetor antigo:
  - as duas diagonais da aba do canto superior esquerdo têm exatamente 45°;
  - a perna direita e a borda interna da perna têm a mesma inclinação (paralelas), e a lateral da contraforma também;
  - a contraforma do "R" usa arcos circulares exatos;
  - a letra fica centrada no quadro de 108 (mesma transformação do ícone adaptativo: cabe na zona segura de 66).

Variações:  a = refinada (fiel ao desenho, cantos vivos)   b = suave (cantos arredondados)   c = a refinada num selo chanfrado
(o chanfro do selo é o mesmo canto cortado dos cartões da interface do R3D PLAY).
Uso: python gerar_svg.py   (grava em branding/svg). Os lockups com texto precisam do fontTools (pip install fonttools brotli).
"""
import math
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(AQUI, 'svg')
FONTE = os.path.join(os.path.dirname(AQUI), 'tools', 'ApolloConfig', 'ui', 'fonts', 'Montserrat-Bold.woff2')

# Variação oficial: A (refinada). As variações B (suave) e C (selo chanfrado) continuam no código para comparações:
# R3D_VARIANTES=abc python gerar_svg.py
VARIANTES = tuple(os.environ.get('R3D_VARIANTES', 'a'))

SCALE, TX, TY = 0.112, 9.42, 10.6      # mesmo enquadramento do ícone adaptativo do celular
STROKE = 22                            # largura do contorno vermelho (em unidades do desenho)
RED, INK = '#E3202C', '#050506'
FUNDO = [(0.0, '#5A0A10'), (0.45, '#22060A'), (1.0, '#050506')]   # gradiente radial do fundo do ícone


def n(v):
    """Número curto para o SVG (2 casas, sem zeros sobrando)."""
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def T(p):
    return (p[0] * SCALE + TX, p[1] * SCALE + TY)


# ---------------------------------------------------------------- geometria (unidades do desenho; centro do traço)
TIP, BAR = (177, 200), (480, 200)
BOWL1 = ((562, 200), (612, 252), (612, 328))
BOWL2 = ((612, 382), (586, 420), (548, 440))
R1, R2 = (616, 575), (478, 575)           # pé direito (externo, interno)
N1, N2 = (424, 468), (352, 468)           # topo do vão entre as pernas
L1, L0 = (336, 575), (214, 575)           # pé esquerdo (interno, externo)
S1, S2, S3 = (214, 478), (190, 454), (190, 365)   # haste: chanfro de 45° e lateral superior
FLAG = (266, 289)                          # vértice interno da aba (S3 -> FLAG e FLAG -> TIP a 45°)
# contraforma: arcos circulares exatos (raio 35) e lateral paralela à perna
K = 0.5523 * 35
COUNTER = dict(a=(370, 305), b=(450, 305), c=(450, 340), r=35, d=(405, 375))


def contour_polygon():
    """Vértices do contorno externo, sem a curva do bojo (que vai de BAR até (548, 440))."""
    return [TIP, BAR, 'BOWL', R1, R2, N1, N2, L1, L0, S1, S2, S3, FLAG]


def sharp_path():
    """Contorno com cantos vivos (variação A/C)."""
    P = lambda p: '%s %s' % tuple(n(v) for v in T(p))
    d = [f'M{P(TIP)}', f'L{P(BAR)}']
    d.append('C' + ' '.join(P(p) for p in BOWL1))
    d.append('C' + ' '.join(P(p) for p in BOWL2))
    for p in (R1, R2, N1, N2, L1, L0, S1, S2, S3, FLAG):
        d.append(f'L{P(p)}')
    d.append('Z')
    return ''.join(d)


def rounded_path(radii):
    """Contorno com cantos arredondados por curvas Q (variação B). radii: raio por vértice (em unidades do desenho)."""
    poly = contour_polygon()
    P = lambda p: '%s %s' % tuple(n(v) for v in T(p))
    # o bojo é tratado como um bloco: os cantos colados nele ficam vivos
    out = []

    def unit(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        return dx / L, dy / L, L

    first = True
    # percorre o contorno; 'BOWL' vira duas curvas cúbicas
    for i, p in enumerate(poly):
        if p == 'BOWL':
            out.append('C' + ' '.join(P(q) for q in BOWL1))
            out.append('C' + ' '.join(P(q) for q in BOWL2))
            continue
        prev = poly[i - 1]
        nxt = poly[(i + 1) % len(poly)]
        sharp = (prev == 'BOWL' or nxt == 'BOWL' or p == BAR)
        prev_pt = BOWL2[2] if prev == 'BOWL' else prev
        nxt_pt = BOWL1[0] if nxt == 'BOWL' else nxt
        r = 0 if sharp else radii.get(p, radii.get('*', 12))
        if r <= 0:
            out.append(('M' if first else 'L') + P(p))
        else:
            ux, uy, lu = unit(p, prev_pt)
            vx, vy, lv = unit(p, nxt_pt)
            d = min(r, lu * 0.45, lv * 0.45)
            a = (p[0] + ux * d, p[1] + uy * d)
            b = (p[0] + vx * d, p[1] + vy * d)
            out.append(('M' if first else 'L') + P(a))
            out.append(f'Q{P(p)} {P(b)}')
        first = False
    out.append('Z')
    return ''.join(out)


def counter_path(round_r=0):
    a, b, c, r, d = COUNTER['a'], COUNTER['b'], COUNTER['c'], COUNTER['r'], COUNTER['d']
    P = lambda p: '%s %s' % tuple(n(v) for v in T(p))
    cx, cy = c
    top, bot = (cx, cy - r), (cx, cy + r)
    right = (cx + r, cy)
    k = K
    if round_r:
        # cantos da esquerda arredondados
        def cut(p, q, rr):
            dx, dy = q[0] - p[0], q[1] - p[1]
            L = math.hypot(dx, dy)
            return (p[0] + dx / L * rr, p[1] + dy / L * rr)
        a1, a2 = cut(a, b, round_r), cut(a, d, round_r)
        d1, d2 = cut(d, a, round_r), cut(d, bot, round_r)
        return (f'M{P(a2)}Q{P(a)} {P(a1)}L{P(top)}C{P((top[0] + k, top[1]))} {P((right[0], right[1] - k))} {P(right)}'
                f'C{P((right[0], right[1] + k))} {P((bot[0] + k, bot[1]))} {P(bot)}L{P(d2)}Q{P(d)} {P(d1)}Z')
    return (f'M{P(a)}L{P(top)}C{P((top[0] + k, top[1]))} {P((right[0], right[1] - k))} {P(right)}'
            f'C{P((right[0], right[1] + k))} {P((bot[0] + k, bot[1]))} {P(bot)}L{P(d)}Z')


def mark_d(variant):
    if variant == 'b':
        return rounded_path({'*': 13, TIP: 20, FLAG: 9, N1: 9, N2: 9}) + counter_path(round_r=7)
    return sharp_path() + counter_path()


def mark_elem(variant, scale=1.0):
    """Elemento <path> colorido da marca (miolo escuro + contorno vermelho)."""
    join = 'round' if variant == 'b' else 'miter'
    return (f'<path fill="{INK}" fill-rule="evenodd" stroke="{RED}" stroke-width="{n(STROKE * SCALE)}" '
            f'stroke-linejoin="{join}" stroke-linecap="round" d="{mark_d(variant)}"/>')


def gradient_def(idname='g'):
    stops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in FUNDO)
    return (f'<radialGradient id="{idname}" gradientUnits="userSpaceOnUse" cx="54" cy="116" r="76">{stops}</radialGradient>')


CHANFRO = 16   # corte do selo (mesma ideia do canto chanfrado dos cartões: superior direito e inferior esquerdo)


def badge_d(inset=0.0):
    a, b = inset, 108 - inset
    c = CHANFRO
    return f'M{n(a)} {n(a)}H{n(b - c)}L{n(b)} {n(a + c)}V{n(b)}H{n(a + c)}L{n(a)} {n(b - c)}Z'


# ---------------------------------------------------------------- arquivos
def svg(viewbox, body, title, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{("<defs>" + defs + "</defs>") if defs else ""}{body}</svg>\n')


def write(name, text):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(text)


def sample_bbox(d_points):
    xs = [p[0] for p in d_points]
    ys = [p[1] for p in d_points]
    return min(xs), min(ys), max(xs), max(ys)


def contour_samples():
    """Pontos do contorno (com o bojo amostrado) para medir a caixa da letra."""
    pts = [T(p) for p in (TIP, BAR)]
    for (c1, c2, p3), p0 in ((BOWL1, BAR), (BOWL2, BOWL1[2])):
        for i in range(1, 17):
            u = i / 16
            a, b, c, e = (1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3
            pts.append(T((a * p0[0] + b * c1[0] + c * c2[0] + e * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + e * p3[1])))
    pts += [T(p) for p in (R1, R2, N1, N2, L1, L0, S1, S2, S3, FLAG)]
    return pts


def text_path(text, size, tracking=0.07):
    """Texto em Montserrat Bold convertido em contornos (não depende da fonte instalada). Devolve (d, largura)."""
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont
    font = TTFont(FONTE)
    gs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
    k = size / upm
    x = 0.0
    parts = []
    for ch in text:
        name = cmap.get(ord(ch))
        if ch == ' ' or name is None:
            x += (font['hmtx'][cmap.get(32, '.notdef')][0] if cmap.get(32) else upm * 0.28) * k + size * tracking
            continue
        pen = SVGPathPen(gs, ntos=lambda v: n(v))
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x, 0)))
        parts.append(pen.getCommands())
        x += font['hmtx'][name][0] * k + size * tracking
    return ''.join(parts), x - size * tracking


def small_icon(variant):
    """Para 16–32 px (bandeja, favicon, lista): contorno mais grosso e letra maior; o traço fino some nesses tamanhos."""
    z = 1.18
    join = 'round' if variant == 'b' else 'miter'
    grp = (f'<g transform="translate(54 54) scale({z}) translate(-54 -54)">'
           f'<path fill="{INK}" fill-rule="evenodd" stroke="{RED}" stroke-width="{n(3.7 / z)}" stroke-linejoin="{join}" d="{mark_d(variant)}"/></g>')
    return svg('0 0 108 108', f'<rect width="108" height="108" rx="24" fill="{INK}"/>' + grp, f'R3D — ícone para tamanhos pequenos ({variant})')


def lockup(variant, texto):
    """Marca + nome em uma linha (texto em curvas, fundo escuro). A marca é recortada rente à letra."""
    if variant == 'c':     # selo inteiro (108 x 108) ao lado do nome
        x0, y0, x1, y1 = 0, 0, 108, 108
        mark = (f'<path d="{badge_d(0)}" fill="url(#g)"/><path d="{badge_d(1.2)}" fill="none" stroke="{RED}" stroke-width="2.4" stroke-opacity=".9"/>' + mark_elem('a'))
        defs = gradient_def()
        ratio, gap, pad = 0.30, 0.22, 0
    else:
        bx0, by0, bx1, by1 = sample_bbox(contour_samples())
        m = STROKE * SCALE / 2 + 2.2        # meia espessura do traço + folga para a ponta (junta viva)
        x0, y0, x1, y1 = bx0 - m, by0 - m, bx1 + m, by1 + m
        mark, defs = mark_elem(variant), ''
        ratio, gap, pad = 0.46, 0.42, 3
    H = y1 - y0
    size = ratio * H / 0.70                  # altura das maiúsculas do Montserrat = 70% do corpo
    d, w = text_path(texto, size)
    tx = x1 + gap * H
    ty = (y0 + y1) / 2 + ratio * H / 2
    body = mark + f'<path fill="#FFFFFF" transform="translate({n(tx)} {n(ty)})" d="{d}"/>'
    vb = f'{n(x0 - pad)} {n(y0 - pad)} {n(tx + w - x0 + 2 * pad)} {n(H + 2 * pad)}'
    return svg(vb, body, texto, defs)


def build():
    for v in VARIANTES:
        nome = {'a': 'refinada', 'b': 'suave', 'c': 'selo chanfrado'}[v]
        mark = mark_elem(v)
        # marca sozinha, fundo transparente (usa em qualquer fundo)
        write(f'r3d-{v}-marca.svg', svg('0 0 108 108', mark, f'R3D — marca ({nome})'))
        # ícone: marca sobre o fundo escuro avermelhado
        if v == 'c':
            body = (f'<path d="{badge_d(0)}" fill="url(#g)"/><path d="{badge_d(1.2)}" fill="none" stroke="{RED}" stroke-width="2.4" stroke-opacity=".9"/>' + mark)
        else:
            body = f'<rect width="108" height="108" rx="24" fill="url(#g)"/>' + mark
        write(f'r3d-{v}-icone.svg', svg('0 0 108 108', body, f'R3D — ícone ({nome})', gradient_def()))
        # versão quadrada sem cantos (para máscaras: ícone adaptativo do Android, favicon recortado pelo sistema)
        if v != 'c':
            write(f'r3d-{v}-icone-quadrado.svg', svg('0 0 108 108', '<rect width="108" height="108" fill="url(#g)"/>' + mark, f'R3D — ícone quadrado ({nome})', gradient_def()))
            write(f'r3d-{v}-icone-pequeno.svg', small_icon(v))
        # monocromática: só a silhueta (centro do traço) com a contraforma vazada; cor pelo texto atual (currentColor)
        x0, y0, x1, y1 = sample_bbox(contour_samples())
        m = 4
        vb = f'{n(x0 - m)} {n(y0 - m)} {n(x1 - x0 + 2 * m)} {n(y1 - y0 + 2 * m)}'
        write(f'r3d-{v}-mono.svg', svg(vb, f'<path fill="currentColor" fill-rule="evenodd" d="{mark_d(v)}"/>', f'R3D — monocromática ({nome})'))
    # lockups horizontais (fundo escuro): marca + nome
    try:
        for v in VARIANTES:
            for nome, texto in (('play', 'R3D PLAY'), ('launcher', 'R3D LAUNCHER')):
                write(f'r3d-{v}-{nome}-horizontal.svg', lockup(v, texto))
    except ImportError:
        print('fontTools ausente: lockups com texto não foram gerados (pip install fonttools brotli)')
    print('ok ->', OUT)


if __name__ == '__main__':
    build()
