# Galos de Combate — cliente (GitHub Pages) + servidor (Socket.IO)

## 1) Publicar CLIENTE no GitHub Pages
- Coloque `client/index.html` neste repositório.
- Em Settings → Pages → "Build and deployment": Branch `main`, folder `/client`.
- Acesse a URL do Pages (ex.: https://seuusuario.github.io/galos-online/).
  - Você pode passar a URL do servidor via querystring:
    `?server=https://SEU-SERVIDOR`

## 2) Publicar SERVIDOR Socket.IO
### Render (mais fácil)
- Crie um novo Web Service a partir da pasta `/server` (ou repo separado).
- Build: `npm install`
- Start: `node server.js`
- Depois pegue a URL: `https://seuapp.onrender.com`

### Railway / Glitch (alternativas)
- Mesmo processo: subir `/server`, rodar `npm install` e `npm start`.

## 3) Apontar o cliente para o servidor
- **Rápido:** abra o Pages com:
  `https://.../index.html?server=https://seuapp.onrender.com`
- **Fixo:** edite `client/index.html` e troque:
  `const SOCKET_URL_DEFAULT = "https://SEU-SERVIDOR-AQUI";`

## Notas
- GitHub Pages **não roda Node/Socket.IO**. Por isso o servidor vai em Render/Railway/Glitch.
- Quando o site estiver em **https://**, o socket deve ser **https://** (Socket.IO já trata o upgrade).
