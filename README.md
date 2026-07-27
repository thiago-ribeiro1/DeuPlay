# 📺 IPTV Player

Um player de IPTV desenvolvido em **JavaScript puro**, que permite ao usuário carregar e assistir canais de televisão via listas M3U, tanto de URLs externas quanto arquivos locais. O player utiliza a biblioteca **hls.js** para suporte ao streaming de vídeos no formato HLS (HTTP Live Streaming).

## 🚀 Funcionalidades

- 🔗 **Carregar lista M3U via URL:** Basta inserir a URL da lista e carregar os canais disponíveis.
- 📂 **Carregar arquivo M3U local:** Permite fazer upload de um arquivo M3U diretamente do seu dispositivo.
- 🌎 **Playlists pré-definidas:**
  - **Todos os Canais:** Lista global com vários canais.
  - **Canais Brasil:** Lista com canais abertos do Brasil.
- 📺 **Reprodução de canais ao vivo:** Reproduza vídeos diretamente no navegador usando o elemento `<video>`.
- 🎚️ **Seleção de canais:** Interface intuitiva para escolher o canal desejado.

💡 **Recomendação:** Para baixar listas IPTV adicionais, visite [htforum.net](http://htforum.net/).

---

## 🖼️ **Pré-visualização**

<img width="1912" height="897" alt="Image" src="https://github.com/user-attachments/assets/c08216aa-19be-4f2a-bd29-7e9d9f816140" />

---

## 💾 Como Usar o Projeto

### 🔨 **Passo 1: Clone o repositório**

```bash
git clone https://github.com/thiago-ribeiro1/IPTV-Player.git
```

### 🖥️ **Passo 2: Abra o projeto no Visual Studio Code**

```bash
cd IPTV-Player
code .
```

### 🌐 **Passo 3: Execute o projeto**

✅ **Recomendado:** Utilize a extensão **Live Server** do VS Code:

1. Clique com o botão direito no arquivo `index.html` localizado no diretório raiz.
2. Selecione **"Open with Live Server"**.

🔗 **Alternativa:** Abra o arquivo `index.html` diretamente em seu navegador.

---

## 📝 Estrutura do Projeto

```
├── css
│   └── style.css               # Estilos personalizados 
├── img
│   ├── glenn-carstens-peters-EOQhsfFBhRk-unsplash.jpg  # Imagem background
│   ├── icon.png                                        # Ícone da aba do navegador
│   ├── Logo horizontal.png                             # Logotipo principal
│   └── logo.png                                        # Logo alternativo
├── js
│   └── script.js               # Lógica principal em JavaScript
│   └── stream.js
├── Listas_IPTV
│   ├── Canais BR.m3u                   # Lista de canais brasileiros
│   ├── Canais_Abertos_BR.m3u           # Canais abertos do Brasil
│   ├── CineTV_Brasil.m3u               # Lista de canais e filmes
│   └── Paulo.m3u                       # Exemplo de lista personalizada
├── index.html                  # Página principal do IPTV Player
```

---

## 📜 **Descrição do Código JavaScript (`script.js`)**

- 🔄 **Gerenciamento de Playlists:** Carrega listas M3U pré-definidas e personalizadas inseridas pelo usuário.
- 🔍 **Análise de Arquivos M3U:** Processa arquivos M3U para extrair nomes e URLs dos canais.
- 🎥 **Reprodução de Vídeo:**
  - Usa `hls.js` para streaming HLS.
  - Suporte nativo para navegadores compatíveis.
- 📝 **Funções Principais:**
  - `addPlaylist()`: Adiciona nova playlist a partir de uma URL.
  - `loadPlaylist(type)`: Carrega e analisa a playlist especificada.
  - `parseM3U(m3uText)`: Analisa o conteúdo do arquivo M3U.
  - `loadLocalFile()`: Carrega e processa arquivos M3U locais.
  - `loadChannel()`: Reproduz o canal selecionado.

---

## ⚡ **Tecnologias Utilizadas**

- 💡 **HTML5**
- 🎨 **CSS3** (com **Bootstrap 5** para responsividade)
- 💻 **JavaScript puro**
- 📚 **hls.js** para suporte a streaming HLS

---

## 📜 **Licença**

Distribuído sob a Licença de Uso Restrito (Licença Proprietária).
Este software e os arquivos de documentação associados são fornecidos exclusivamente para uso pessoal e educacional.
Veja o arquivo [LICENSE](https://github.com/thiago-ribeiro1/IPTV-Player/blob/main/LICENSE) para mais informações.

---

Desenvolvido por [Thiago Ribeiro](https://github.com/thiago-ribeiro1) 
