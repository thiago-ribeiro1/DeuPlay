// Classificacao de falhas em um vocabulario estavel, usado por probe e pelos
// workers de FFmpeg para que a UI mostre sempre a mesma causa para o mesmo problema.

export const DiagnosticCode = Object.freeze({
  DNS_RESOLUTION_FAILED: 'dns_resolution_failed',
  TIMEOUT: 'timeout',
  CONNECTION_REFUSED: 'connection_refused',
  CONNECTION_RESET: 'connection_reset',
  HTTP_STATUS: 'http_status',
  AUTH_REQUIRED: 'auth_required',
  INVALID_FORMAT: 'invalid_format',
  EMPTY_PLAYLIST: 'empty_playlist',
  SEGMENT_UNAVAILABLE: 'segment_unavailable',
  CODEC_NOT_RECOGNIZED: 'codec_not_recognized',
  NO_VIDEO: 'no_video',
  NO_AUDIO: 'no_audio',
  FFMPEG_EXITED: 'ffmpeg_exited',
  TIMESTAMP_ERROR: 'timestamp_error',
  HLS_GENERATION_FAILED: 'hls_generation_failed',
  ENCRYPTED_STREAM: 'encrypted_stream',
  DRM_DETECTED: 'drm_detected',
  RESOURCE_LIMIT: 'resource_limit',
  NETWORK_BLOCKED: 'network_blocked',
  FFMPEG_NOT_INSTALLED: 'ffmpeg_not_installed',
  FFPROBE_NOT_INSTALLED: 'ffprobe_not_installed',
  UNKNOWN_ERROR: 'unknown_error',
});

const PATTERNS = [
  [
    /Name or service not known|nodename nor servname|Temporary failure in name resolution/i,
    DiagnosticCode.DNS_RESOLUTION_FAILED,
  ],
  [
    /Connection timed out|Operation timed out|timed out after|I\/O timeout/i,
    DiagnosticCode.TIMEOUT,
  ],
  [/Connection refused/i, DiagnosticCode.CONNECTION_REFUSED],
  [/Connection reset by peer|ECONNRESET/i, DiagnosticCode.CONNECTION_RESET],
  [/HTTP error 401|HTTP error 403|Unauthorized|Forbidden/i, DiagnosticCode.AUTH_REQUIRED],
  [/HTTP error (\d{3})/i, DiagnosticCode.HTTP_STATUS],
  [/Invalid data found when processing input|moov atom not found/i, DiagnosticCode.INVALID_FORMAT],
  [/Playlist is empty|empty playlist/i, DiagnosticCode.EMPTY_PLAYLIST],
  [/Failed to open segment|404.*\.ts|Unable to open resource/i, DiagnosticCode.SEGMENT_UNAVAILABLE],
  [
    /Unknown decoder|Unsupported codec|Encoder not found|codec not currently supported/i,
    DiagnosticCode.CODEC_NOT_RECOGNIZED,
  ],
  [
    /Non-monotonic DTS|Application provided invalid, non monotonically increasing dts|timestamp discontinuity/i,
    DiagnosticCode.TIMESTAMP_ERROR,
  ],
  [/EXT-X-KEY|crypt|decryption failed/i, DiagnosticCode.ENCRYPTED_STREAM],
  [/widevine|fairplay|playready|drm/i, DiagnosticCode.DRM_DETECTED],
  [
    /Cannot allocate memory|Resource temporarily unavailable|No space left on device/i,
    DiagnosticCode.RESOURCE_LIMIT,
  ],
  [/Network is unreachable|blocked by/i, DiagnosticCode.NETWORK_BLOCKED],
];

export function classifyFfmpegLikeError(stderrText, exitCode) {
  const text = stderrText || '';

  for (const [pattern, code] of PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      if (code === DiagnosticCode.HTTP_STATUS) {
        return { code, detail: `A origem respondeu HTTP ${match[1]}.` };
      }
      return { code, detail: describeCode(code) };
    }
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return {
      code: DiagnosticCode.FFMPEG_EXITED,
      detail: `Processo encerrou com codigo ${exitCode}.`,
    };
  }

  return {
    code: DiagnosticCode.UNKNOWN_ERROR,
    detail: 'Falha nao classificada. Veja os logs para detalhes.',
  };
}

export function describeCode(code) {
  const messages = {
    [DiagnosticCode.DNS_RESOLUTION_FAILED]: 'Nao foi possivel resolver o endereco (DNS).',
    [DiagnosticCode.TIMEOUT]: 'A origem nao respondeu a tempo.',
    [DiagnosticCode.CONNECTION_REFUSED]: 'A origem recusou a conexao.',
    [DiagnosticCode.CONNECTION_RESET]: 'A conexao foi encerrada abruptamente pela origem.',
    [DiagnosticCode.HTTP_STATUS]: 'A origem respondeu com um status HTTP de erro.',
    [DiagnosticCode.AUTH_REQUIRED]: 'A origem exige autenticacao ou o token expirou.',
    [DiagnosticCode.INVALID_FORMAT]: 'O conteudo recebido nao e um formato de midia reconhecivel.',
    [DiagnosticCode.EMPTY_PLAYLIST]: 'A playlist HLS remota esta vazia.',
    [DiagnosticCode.SEGMENT_UNAVAILABLE]: 'Um ou mais segmentos nao estao disponiveis na origem.',
    [DiagnosticCode.CODEC_NOT_RECOGNIZED]: 'Codec nao reconhecido ou nao suportado.',
    [DiagnosticCode.NO_VIDEO]: 'Nenhuma faixa de video foi encontrada na origem.',
    [DiagnosticCode.NO_AUDIO]: 'Nenhuma faixa de audio foi encontrada na origem.',
    [DiagnosticCode.FFMPEG_EXITED]: 'O processo FFmpeg foi encerrado inesperadamente.',
    [DiagnosticCode.TIMESTAMP_ERROR]: 'Timestamps irregulares na origem (discontinuidade).',
    [DiagnosticCode.HLS_GENERATION_FAILED]: 'Falha ao gerar a saida HLS local.',
    [DiagnosticCode.ENCRYPTED_STREAM]: 'O stream esta criptografado (chave HLS).',
    [DiagnosticCode.DRM_DETECTED]: 'Foi detectado DRM; reproducao nao suportada.',
    [DiagnosticCode.RESOURCE_LIMIT]: 'Limite de recursos da maquina local atingido.',
    [DiagnosticCode.NETWORK_BLOCKED]: 'A conexao foi bloqueada pela rede.',
    [DiagnosticCode.FFMPEG_NOT_INSTALLED]:
      'FFmpeg nao esta instalado ou FFMPEG_PATH esta incorreto.',
    [DiagnosticCode.FFPROBE_NOT_INSTALLED]:
      'ffprobe nao esta instalado ou FFPROBE_PATH esta incorreto.',
    [DiagnosticCode.UNKNOWN_ERROR]: 'Nao foi possivel reproduzir este canal.',
  };
  return messages[code] || messages[DiagnosticCode.UNKNOWN_ERROR];
}
