# DeuPlay

Eu usava outro player web de **IPTV**, mas notei que travava com frequência. Em vez de só trocar de ferramenta, decidi investigar a causa dessas falhas, e acabei construindo o meu próprio, pensado para uso local.

**DeuPlay** é um player de IPTV com **JavaScript puro** no frontend e **Node.js/Express** no backend, que carrega e reproduz canais a partir de listas M3U (URL ou arquivo local) ou de um painel Xtream. O grande desafio foi fazer os streams tocarem de forma confiável no navegador, contornando CORS, conteúdo misto e a variedade de formatos que costumam travar os players web. Para isso, usa hls.js na reprodução HLS e FFmpeg para análise, remux e transcodificação dos canais quando necessário.

---

## Funcionalidades

- Carregar lista M3U via URL ou arquivo local: cole o link da playlist ou faça upload direto do dispositivo.
- Login Xtream: conecte-se a um painel informando servidor, usuário e senha e importe o catálogo ao vivo direto da API. As credenciais, quando salvas, são cifradas em repouso com AES-256-GCM (chave derivada por scrypt de uma senha de acesso que nunca é gravada).
- Estratégia de reprodução automática: o backend sonda o stream (via ffprobe) e escolhe a melhor abordagem — reprodução direta, proxy HTTP/HLS, remux ou transcodificação completa (vídeo, áudio ou ambos) — sem precisar de nada manual.
- Aceleração por hardware: detecta e usa NVENC/QuickSync/VAAPI/VideoToolbox/AMF quando disponíveis, caindo para libx264 (software) se nada for compatível.
- Validação de URLs: bloqueia por padrão acesso a hosts privados/localhost, protegendo contra SSRF.
- Painel de diagnóstico (/admin): mostra streams ativos, estratégia usada, status, viewers, PID e erros em tempo real, com ações administrativas.
- Health check (/api/health): status do FFmpeg/ffprobe, streams ativos e uso de disco, tudo em JSON.
- Limpeza automática: sessões e processos ociosos se encerram sozinhos, e os arquivos de stream são zerados a cada boot.
- Pronto para Docker: Dockerfile e docker-compose.yml inclusos, já com FFmpeg embutido na imagem.

---

## **Pré-visualização**

<img width="1910" height="897" alt="Image" src="https://github.com/user-attachments/assets/d88c15bc-8d33-4c0f-a437-991710c56f05" />
<img width="1908" height="900" alt="Image" src="https://github.com/user-attachments/assets/7cb86bac-13b3-47b7-b16f-1ea4bbc99710" />

---

## Como usar o projeto

### Pré-requisitos

- [Node.js](https://nodejs.org/) 18.17 ou superior
- [FFmpeg](https://ffmpeg.org/) instalado (precisa do `ffmpeg` e `ffprobe` no PATH, ou configure os caminhos no `.env`)

### Passo 1: Clone o repositório

```bash
git clone https://github.com/thiago-ribeiro1/DeuPlay.git
cd DeuPlay
```

### Passo 2: Instale as dependências

```bash
npm install
```

### Passo 3: Configure o ambiente

Copie o `.env.example` para `.env` e ajuste se precisar (porta, limites de streams simultâneos, modo de reprodução, etc.):

```bash
cp .env.example .env
```

### Passo 4: Rode o servidor

```bash
npm start
```

Ou em modo desenvolvimento (com reload automático a cada alteração):

```bash
npm run dev
```

Acesse **http://localhost:3000** no navegador. O painel de diagnóstico fica em **http://localhost:3000/admin**.

### Alternativa: Docker

```bash
docker compose up --build
```

## Testes

```bash
npm test
```

---

## Estrutura do Projeto

```
├── server/                           # Backend Node/Express
│   ├── app.js                        # Bootstrap do servidor
│   ├── config.js                     # Configuração via variáveis de ambiente
│   ├── store.js                      # Store em memória (playlists e canais)
│   ├── routes/                       # Endpoints da API
│   │   ├── playlists.js               # Importação de listas M3U (URL e upload)
│   │   ├── xtream.js                  # Login e importação por painel Xtream
│   │   ├── channels.js                # Consulta e filtro de canais
│   │   ├── playback.js                # Resolução da estratégia de reprodução
│   │   ├── streams.js                 # Entrega dos streams gerados
│   │   └── health.js                  # Health check e diagnóstico
│   ├── services/
│   │   ├── m3uParser.js               # Parser de listas M3U
│   │   ├── xtreamClient.js            # Cliente da API Xtream Codes
│   │   ├── credentialStore.js         # Credenciais do painel cifradas em repouso
│   │   ├── secretBox.js               # AES-256-GCM com chave derivada por scrypt
│   │   ├── probeService.js            # Sondagem de canais (formato, codec, disponibilidade)
│   │   ├── strategy.js                # Escolha entre direto, proxy ou remux
│   │   ├── playbackOrchestrator.js    # Orquestração da reprodução
│   │   ├── httpProxy.js               # Proxy HTTP (CORS e conteúdo misto)
│   │   ├── hlsProxy.js                # Proxy de manifesto e segmentos HLS
│   │   ├── ffmpegArgs.js              # Montagem dos argumentos do FFmpeg
│   │   ├── processManager.js          # Ciclo de vida dos processos FFmpeg
│   │   ├── hardware.js                # Detecção de aceleração por hardware
│   │   ├── diagnostics.js             # Coleta de métricas para o painel
│   │   └── cleanup.js                 # Remoção de streams temporários
│   ├── security/
│   │   └── validateUrl.js             # Validação de URLs (proteção contra SSRF)
│   └── utils/
│       ├── logger.js                  # Log estruturado com redação de credenciais
│       └── ids.js                     # Geração de IDs estáveis
├── public/                            # Frontend estático
│   ├── index.html                     # Página principal do player
│   ├── admin.html                     # Painel de diagnóstico
│   ├── js/script.js                   # Lógica do player (playlists, Xtream, player, API)
│   ├── css/style.css
│   ├── img/                          # Logomarca e imagens
│   └── Listas_IPTV/                  # Playlists M3U de exemplo
├── tests/                            # Testes automatizados (unitários, integração e e2e)
│   ├── fixtureServer.js              # Servidor de fixtures para os testes
│   ├── generateFixtures.js           # Geração dos arquivos de mídia de teste
│   └── setupEnv.js                   # Ambiente compartilhado entre suítes
├── data/                             # Credenciais cifradas (gerado, fora do Git)
├── media/streams/                    # Saída temporária dos streams gerados pelo FFmpeg
├── Dockerfile / docker-compose.yml
├── eslint.config.js
└── .env.example                     # Variáveis de ambiente disponíveis
```

---

## Tecnologias Utilizadas

- **Node.js + Express** no backend
- **FFmpeg/ffprobe** para probing, remux e transcodificação
- **JavaScript puro** no frontend
- **hls.js** para streaming HLS no navegador
- **HTML5 + CSS3**
- **Docker** para deploy

---

## Licença

Distribuído sob a Licença Pública Geral GNU v3.0 (GPL-3.0).
Você pode usar, estudar, modificar e redistribuir este software livremente, desde que
mantenha o aviso de copyright original e publique sob a mesma licença qualquer versão
derivada. Veja o arquivo [LICENSE](https://github.com/thiago-ribeiro1/DeuPlay/blob/main/LICENSE) para mais informações.

Copyright (C) 2025-2026 Thiago Ribeiro ([@thiago-ribeiro1](https://github.com/thiago-ribeiro1))

> Este projeto é um **player**: ele não hospeda, distribui nem fornece qualquer conteúdo.
> Todas as listas, painéis e credenciais são fornecidos pelo próprio usuário, que é o
> único responsável por garantir que possui direito de acesso ao conteúdo que reproduz.

## License

Distributed under the GNU General Public License v3.0 (GPL-3.0).
You are free to use, study, modify and redistribute this software, provided that you
keep the original copyright notice and release any derivative work under the same
license. See the [LICENSE](https://github.com/thiago-ribeiro1/DeuPlay/blob/main/LICENSE) file for more information.

Copyright (C) 2025-2026 Thiago Ribeiro ([@thiago-ribeiro1](https://github.com/thiago-ribeiro1))

> This project is a **player**: it does not host, distribute or provide any content.
> All playlists, panels and credentials are supplied by the user, who is solely
> responsible for ensuring they have the right to access the content they play.
