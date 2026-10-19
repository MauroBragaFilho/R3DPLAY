"""Gera os ícones do R3D PLAY no PC (R3D em todos os tamanhos e estados da bandeja) a partir de gerar_logo.py.

Sobrescreve os arquivos de ícone do Apollo mantendo os nomes (apollo.ico, apollo-playing.ico...), então o código e o CMake
continuam funcionando sem mudanças. Uso: python gerar_icones_pc.py
"""
import os

from PIL import Image, ImageDraw

import gerar_logo as logo

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
IMAGENS = os.path.join(RAIZ, "src_assets", "common", "assets", "web", "public", "images")

ESTADOS = {
    "playing": ((46, 204, 113), "#2ECC71"),
    "pausing": ((245, 166, 35), "#F5A623"),
    "locked": ((140, 140, 150), "#8C8C96"),
}


def com_selo(img, cor, escurecer=False):
    """Pinta uma bolinha colorida no canto inferior direito (estado da bandeja)."""
    n = img.size[0]
    out = img.convert("RGBA")
    if escurecer:
        out = Image.blend(out, Image.new("RGBA", out.size, (20, 20, 24, 255)), 0.45)
    d = ImageDraw.Draw(out)
    r = n * 0.165     # selo menor e no canto: a perna direita do R continua legível nos tamanhos da bandeja
    cx, cy = n * 0.795, n * 0.795
    d.ellipse([cx - r - n * 0.03, cy - r - n * 0.03, cx + r + n * 0.03, cy + r + n * 0.03], fill=(5, 5, 6, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=cor + (255,))
    return out


def svg_estado(hex_cor, escurecer):
    base = logo.svg(True).replace("</svg>\n", "")
    extra = '<rect width="108" height="108" fill="#14141a" opacity="0.45"/>' if escurecer else ""
    selo = f'<circle cx="86" cy="86" r="20.5" fill="#050506"/><circle cx="86" cy="86" r="17.8" fill="{hex_cor}"/>'
    return base + extra + selo + "</svg>\n"


def salvar_ico(imagens_por_tamanho, caminho, tamanhos):
    base = imagens_por_tamanho[max(tamanhos)]
    base.save(caminho, sizes=[(s, s) for s in tamanhos], append_images=[imagens_por_tamanho[s] for s in tamanhos if s != max(tamanhos)])


if __name__ == "__main__":
    tam_ico = (256, 64, 48, 32, 16)
    normais = {s: logo.render(s, margem=0.04) for s in set(tam_ico) | {45, 512}}

    # ícone principal (executável, instalador, atalho)
    salvar_ico(normais, os.path.join(RAIZ, "apollo.ico"), tam_ico)
    normais[512].save(os.path.join(RAIZ, "apollo.png"))
    open(os.path.join(RAIZ, "apollo.svg"), "w", encoding="utf-8").write(logo.svg(True))

    # imagens do painel web e da bandeja
    salvar_ico(normais, os.path.join(IMAGENS, "apollo.ico"), tam_ico)
    normais[16].save(os.path.join(IMAGENS, "logo-apollo-16.png"))
    normais[45].save(os.path.join(IMAGENS, "logo-apollo-45.png"))
    open(os.path.join(IMAGENS, "logo-apollo.svg"), "w", encoding="utf-8").write(logo.svg(True))

    for nome, (cor, hexcor) in ESTADOS.items():
        escuro = nome == "locked"
        por_tam = {s: com_selo(logo.render(s, margem=0.04), cor, escuro) for s in set(tam_ico) | {45}}
        salvar_ico(por_tam, os.path.join(IMAGENS, f"apollo-{nome}.ico"), tam_ico)
        por_tam[16].save(os.path.join(IMAGENS, f"apollo-{nome}-16.png"))
        por_tam[45].save(os.path.join(IMAGENS, f"apollo-{nome}-45.png"))
        com_selo(logo.render(256, margem=0.04), cor, escuro).save(os.path.join(IMAGENS, f"apollo-{nome}.png"))
        open(os.path.join(IMAGENS, f"apollo-{nome}.svg"), "w", encoding="utf-8").write(svg_estado(hexcor, escuro))
    print("ok")
