# PiP Flutuante — extensão do Chrome

Janela de vídeo flutuante por cima de todos os programas, com player estilo YouTube (legendas, velocidade,
qualidade, playlist, timer de suspensão) e abertura automática ao sair da aba.

## Instalar
1. `chrome://extensions` → ative **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione esta pasta.

## Usar
Passe o mouse sobre um vídeo e clique em **Flutuar**, ou `Alt+P`, ou clique no ícone da extensão.

Instruções completas e atalhos: `LEIA-ME.txt`. Requer Chrome 116+.

| Arquivo | Função |
|---|---|
| `manifest.json` | Manifesto da extensão (MV3) |
| `background.js` | Service worker (ícone, menu, atalho) |
| `content.js` | Botão "Flutuar", janela PiP e player |
| `yt-bridge.js` | Ponte com o player do YouTube (playlist, qualidade, anúncios) |
