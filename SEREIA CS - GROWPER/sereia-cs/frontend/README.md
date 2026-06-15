# Sereia CS — Dashboard

Frontend HTML/JS estático do Sereia CS. Conecta no backend via REST + WebSocket.

## Deploy no Netlify

1. Conecte o repositório `mktdaniel1/sereia-cs-frontend` ao Netlify.
2. Build settings: deixe vazio (site estático). Publish directory: `.`.
3. Em `app.js`, ajuste `API_BASE` para a URL do seu backend Railway, OU defina antes do `<script src="app.js">` no `index.html`:

```html
<script>window.SEREIA_API_BASE = 'https://sereia-cs.up.railway.app';</script>
<script src="app.js"></script>
```

4. No backend, adicione a URL do Netlify em `FRONTEND_URL` (para liberar CORS).

## Como acessar

1. Abra a URL do Netlify
2. Cole o `CS_DASHBOARD_TOKEN` configurado no backend
3. Entre - o token fica salvo no localStorage do navegador

## Estrutura

```
index.html    Estrutura + tela de login + abas
styles.css    Paleta Sereia + densidade do wireframe aprovado
app.js        Fetch + WebSocket + render
netlify.toml  Headers de segurança
```

## Abas

- **Volume** (implementada) — cards hoje/semana/mês, série temporal 30d, heatmap, top 10 clientes
- **Backlog ao vivo** (implementada) — KPIs por semáforo, lista atualizada via WebSocket
- **SLA** (placeholder, F2)
- **Reincidência** (placeholder, F3)
