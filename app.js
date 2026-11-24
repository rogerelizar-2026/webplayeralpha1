/**
 * StudioFlow // Winamp Spectrum Web Player — Versão Final Auditada
 *  - Busca em qualquer extensão (.mp3, .mp4, .rma, .m4a, .flac, .rmv, .aac, .ogg, .wav, .wma, .webm, .mkv, etc.)
 *  - Varredura e parsing de listas .m3u / .m3u8 na web que citem o cantor pesquisado
 *  - Som garantido (HTML5 <audio> direto, zero AudioContext/captureStream)
 *  - Letras sem seletor de idioma + detecção automática + tradução sempre para PT-BR
 *  - História validada exclusivamente para composição/compositor/letrista (traduzida p/ PT-BR)
 *  - Ano da gravação original + capa fallback multi-fonte + M3U enriquecida
 */
(() => {
  "use strict";

  const MIN_FULL_TRACK_SECONDS = 45;
  const DEFAULT_COVER_SVG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23080d14'/%3E%3Ccircle cx='60' cy='60' r='34' fill='none' stroke='%2322d3ee' stroke-width='4'/%3E%3Ccircle cx='60' cy='60' r='10' fill='%2322d3ee'/%3E%3C/svg%3E";

  // Todas as extensões de áudio/vídeo suportadas na busca e no link direto
  const ANY_MEDIA_EXT_REGEX =
    /\.(mp3|mp4|m4a|flac|ogg|oga|opus|wav|aac|wma|rma|rm|rmvb|rmv|ram|webm|mkv|avi|mov|flv|3gp|ts|ac3|aiff|alac|ape|amr)$/i;

  const BROWSER_PLAYABLE_EXT_PRIORITY = [
    "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "mp4", "webm", "ogv", "mov", "3gp"
  ];

  const LEGACY_NON_BROWSER_EXT_REGEX = /\.(rma|rm|rmvb|rmv|ram|wma|avi|flv|ape|ac3)$/i;

  const metadataCache = new Map();
  let audiusHostCache = null;

  /* =========================================================================
   * 1. UTILITÁRIOS, EXTENSÕES & DETECTOR DE IDIOMA
   * ========================================================================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sanitizeSearchQuery(q) {
    return String(q || "")
      .replace(/[–—]/g, " ")
      .replace(/\s*-\s*/g, " ")
      .replace(/[()[\]{}"']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitArtistTitleFromQuery(rawQuery) {
    const parts = String(rawQuery || "").split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      return { partA: parts[0].trim(), partB: parts.slice(1).join(" ").trim() };
    }
    return null;
  }

  function extractSingerCandidate(rawQuery) {
    const split = splitArtistTitleFromQuery(rawQuery);
    if (split) {
      // Ex.: "detalhes - roberto carlos" -> retorna ambos para testar em listas M3U
      return [split.partB, split.partA].filter((x) => x.length >= 2);
    }
    const clean = sanitizeSearchQuery(rawQuery);
    return clean ? [clean] : [];
  }

  function cleanTrackName(title) {
    return (title || "")
      .replace(/\(feat\..*?\)/gi, "")
      .replace(/\(ft\..*?\)/gi, "")
      .replace(/\[.*?\]/g, "")
      .replace(/- Remastered.*$/i, "")
      .replace(/- Live.*$/i, "")
      .replace(/- Ao Vivo.*$/i, "")
      .trim();
  }

  function extractYear(val) {
    const match = String(val || "").match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : "";
  }

  function pickEarliestYear(...candidates) {
    const currentYear = new Date().getFullYear();
    const years = candidates
      .map((c) => Number(extractYear(c)))
      .filter((y) => Number.isFinite(y) && y >= 1900 && y <= currentYear);
    return years.length ? String(Math.min(...years)) : "";
  }

  function capitalizeWords(text) {
    return String(text || "").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function isGenericGenre(genre) {
    if (!genre) return true;
    return /^(m[uú]sica|music|acervo completo|acervo aberto|streaming por link|streaming completo|streaming oficial|áudio completo|audio completo|lista \.m3u|não informado)$/i.test(
      genre.trim()
    );
  }

  function getFileExtension(urlOrName) {
    const clean = String(urlOrName || "").split("?")[0].split("#")[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : "";
  }

  function isBrowserPlayableMedia(fileNameOrUrl, audioElement) {
    const ext = getFileExtension(fileNameOrUrl);
    if (!ext) return true; // streams sem extensão (ex.: Audius / Icecast)
    if (LEGACY_NON_BROWSER_EXT_REGEX.test("." + ext)) return false;
    if (!audioElement) return BROWSER_PLAYABLE_EXT_PRIORITY.includes(ext);

    const mimeMap = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/ogg; codecs=opus",
      wav: "audio/wav",
      flac: "audio/flac",
      webm: "audio/webm",
      ogv: "audio/ogg"
    };
    const mime = mimeMap[ext];
    if (!mime) return BROWSER_PLAYABLE_EXT_PRIORITY.includes(ext);
    return audioElement.canPlayType(mime) !== "";
  }

  function parseDurationSeconds(val) {
    if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
    if (!val) return 0;
    const str = String(val).trim();
    if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str));
    const parts = str.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  function isSampleOrPreviewUrl(url, title = "") {
    if (!url) return true;
    const sampleUrlRegex =
      /audio-ssl\.itunes\.apple\.com|cdns-preview|p\.scdn\.co\/mp3-preview|dzcdn\.net\/stream|\/previews?\b|\/samples?\b|[?&](preview|sample)=/i;
    if (sampleUrlRegex.test(url)) return true;
    return /\b(30s\s*preview|audio\s*preview|sample\s*clip)\b/i.test(title);
  }

  function isSampleDuration(sec) {
    return Number.isFinite(sec) && sec > 0 && sec < MIN_FULL_TRACK_SECONDS;
  }

  // Detector automático de idioma (dispensa seletor manual)
  function detectLanguageCode(text) {
    const sample = String(text || "").slice(0, 1800);
    if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(sample)) return "ja";
    if (/[\uac00-\ud7af]/.test(sample)) return "ko";
    if (/[\u0400-\u04ff]/.test(sample)) return "ru";
    if (/[\u0600-\u06ff]/.test(sample)) return "ar";
    if (/[\u0370-\u03ff]/.test(sample)) return "el";

    const lower = ` ${sample.toLowerCase()} `;
    const scores = { pt: 0, en: 0, es: 0, fr: 0, it: 0, de: 0 };

    if (/[ãõç]/.test(lower)) scores.pt += 6;
    if (/[ñ¿¡]/.test(lower)) scores.es += 6;
    if (/[ßäöü]/.test(lower)) scores.de += 5;
    if (/[àâæçèêëîïôœùûü]/.test(lower)) scores.fr += 3;

    const dict = {
      pt: [" você ", " não ", " com ", " para ", " que ", " uma ", " meu ", " minha ", " são ", " mais ", " tudo ", " amor ", " coração ", " quando ", " eu ", " nós "],
      en: [" the ", " and ", " you ", " that ", " with ", " for ", " this ", " my ", " your ", " love ", " when ", " what ", " don't ", " i'm ", " we ", " are "],
      es: [" que ", " los ", " las ", " por ", " para ", " con ", " pero ", " una ", " tu ", " yo ", " mi ", " amor ", " cuando ", " siempre ", " eres ", " corazón "],
      fr: [" les ", " des ", " une ", " dans ", " pour ", " avec ", " je ", " tu ", " nous ", " vous ", " mais ", " pas ", " mon ", " amour ", " c'est ", " qui "],
      it: [" che ", " non ", " per ", " con ", " una ", " sono ", " mio ", " mia ", " amore ", " quando ", " più ", " tutto ", " cuore ", " nel ", " della "],
      de: [" der ", " die ", " das ", " und ", " ich ", " nicht ", " mit ", " ein ", " eine ", " ist ", " für ", " auf ", " du ", " wir ", " mein "]
    };

    for (const [lang, words] of Object.entries(dict)) {
      for (const w of words) {
        if (lower.includes(w)) scores[lang] += 2;
      }
    }

    let bestLang = "en";
    let bestScore = -1;
    for (const [lang, sc] of Object.entries(scores)) {
      if (sc > bestScore) {
        bestScore = sc;
        bestLang = lang;
      }
    }
    return bestScore > 0 ? bestLang : "en";
  }

  function languageDisplayName(code) {
    const map = {
      pt: "Português",
      en: "Inglês",
      es: "Espanhol",
      fr: "Francês",
      it: "Italiano",
      de: "Alemão",
      ja: "Japonês",
      ko: "Coreano",
      ru: "Russo",
      ar: "Árabe",
      el: "Grego"
    };
    return map[code] || code.toUpperCase();
  }

  function parseOfficialEmbed(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();

      if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
        let videoId = "";
        if (host === "youtu.be") videoId = u.pathname.slice(1).split("/")[0];
        else if (u.searchParams.get("v")) videoId = u.searchParams.get("v");
        else if (u.pathname.startsWith("/embed/")) videoId = u.pathname.split("/")[2];
        if (videoId) {
          return {
            provider: "YouTube",
            src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1`,
            height: 220
          };
        }
      }

      if (host === "soundcloud.com" || host === "m.soundcloud.com") {
        return {
          provider: "SoundCloud",
          src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true&show_artwork=true&visual=false`,
          height: 166
        };
      }

      if (host === "open.spotify.com") {
        const parts = u.pathname.split("/").filter(Boolean);
        if ((parts[0] === "track" || parts[0] === "album" || parts[0] === "playlist") && parts[1]) {
          return {
            provider: "Spotify",
            src: `https://open.spotify.com/embed/${parts[0]}/${encodeURIComponent(parts[1])}`,
            height: 152
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function jsonpRequest(url, callbackParam = "callback", timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const cbName = `__studioflow_cb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        if (window[cbName]) delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Tempo esgotado na API"));
      }, timeoutMs);

      window[cbName] = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("Falha ao carregar script"));
      };

      const sep = url.includes("?") ? "&" : "?";
      script.src = `${url}${sep}${encodeURIComponent(callbackParam)}=${encodeURIComponent(cbName)}`;
      document.head.appendChild(script);
    });
  }

  async function fetchJsonWithJsonpFallback(url, callbackParam = "callback") {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // Fallback JSONP para ambientes file://
    }
    return await jsonpRequest(url, callbackParam);
  }

  function splitTextIntoChunks(text, maxLen = 420) {
    const lines = (text || "").split("\n");
    const chunks = [];
    let current = "";

    const pushSegment = (segment) => {
      if ((current + "\n" + segment).length > maxLen && current.length > 0) {
        chunks.push(current);
        current = segment;
      } else {
        current = current ? `${current}\n${segment}` : segment;
      }
    };

    for (const line of lines) {
      if (line.length <= maxLen) {
        pushSegment(line);
      } else {
        const sentences = line.match(/[^.!?]+[.!?]*\s*/g) || [line];
        for (const s of sentences) {
          if (s.length <= maxLen) {
            pushSegment(s.trimEnd());
          } else {
            const words = s.split(/\s+/);
            let part = "";
            for (const w of words) {
              if ((part + " " + w).length > maxLen && part) {
                pushSegment(part);
                part = w;
              } else {
                part = part ? `${part} ${w}` : w;
              }
            }
            if (part) pushSegment(part);
          }
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // Traduz automaticamente para PT-BR (inclusive se a letra já vier em Português)
  async function translateTextToPtBr(rawText, explicitSourceLang = null) {
    const clean = (rawText || "").trim();
    if (!clean) return { translated: "", detectedLang: "en" };

    const detectedLang = explicitSourceLang || detectLanguageCode(clean);
    const pairSource = detectedLang === "pt" ? "pt-PT" : detectedLang;

    const chunks = splitTextIntoChunks(clean, 420);
    const translatedChunks = [];

    for (const chunk of chunks) {
      if (!chunk.trim()) {
        translatedChunks.push("");
        continue;
      }
      const endpoint = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(pairSource)}|pt-BR`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.responseStatus !== 200 && data.responseStatus !== "200") {
        if (detectedLang === "pt") return { translated: clean, detectedLang };
        throw new Error(data.responseDetails || "Limite de tradução atingido");
      }
      translatedChunks.push(data.responseData.translatedText);
    }

    return { translated: translatedChunks.join("\n"), detectedLang };
  }

  /* =========================================================================
   * 2. METADADOS ORIGINAIS, WIKIDATA, COMPOSITOR/LETRISTA & CAPA
   * ========================================================================= */
  async function fetchItunesMetadataOnly(artist, title) {
    // ESTRITAMENTE metadados (Capa, Gênero, Ano) — nunca utiliza prévia de áudio
    try {
      const term = sanitizeSearchQuery(`${artist} ${cleanTrackName(title)}`);
      if (!term) return null;
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`;
      const data = await jsonpRequest(url, "callback");
      const items = data?.results || [];
      if (!items.length) return null;

      const earliestYear = pickEarliestYear(...items.map((x) => x.releaseDate));
      const best = items[0];
      return {
        cover: (best.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
        genre: best.primaryGenreName || "",
        year: earliestYear
      };
    } catch {
      return null;
    }
  }

  async function fetchDeezerCoverOnly(artist, title) {
    try {
      const term = sanitizeSearchQuery(`${artist} ${cleanTrackName(title)}`);
      if (!term) return "";
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=3&output=jsonp`;
      const data = await jsonpRequest(url, "callback");
      const item = data?.data?.[0];
      return item?.album?.cover_big || item?.album?.cover_medium || "";
    } catch {
      return "";
    }
  }

  async function fetchCoverArtArchiveUrl(releaseIds) {
    for (const rid of releaseIds.slice(0, 3)) {
      try {
        const res = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(rid)}`);
        if (!res.ok) continue;
        const data = await res.json();
        const front = (data.images || []).find((img) => img.front) || data.images?.[0];
        const thumb = front?.thumbnails?.["500"] || front?.thumbnails?.large || front?.image;
        if (thumb) return thumb.replace(/^http:\/\//i, "https://");
      } catch {
        // Próximo release
      }
    }
    return "";
  }

  async function fetchWikidataCredits(artist, title) {
    try {
      const q = sanitizeSearchQuery(`${title} ${artist}`);
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=pt&uselang=pt&format=json&limit=4&origin=*`;
      const sData = await fetchJsonWithJsonpFallback(searchUrl, "callback");
      const hits = sData?.search || [];
      if (!hits.length) return null;

      const songHit =
        hits.find((h) => /canção|música|song|single|composition|composição|track|ballad/i.test(h.description || "")) ||
        hits[0];

      const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(songHit.id)}&props=claims|descriptions|labels&languages=pt|en&format=json&origin=*`;
      const entData = await fetchJsonWithJsonpFallback(entUrl, "callback");
      const entity = entData?.entities?.[songHit.id];
      if (!entity?.claims) return null;

      const claims = entity.claims;
      const p31Ids = (claims.P31 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      const isMusicEntity =
        /canção|música|song|single|composition|composição/i.test(songHit.description || "") ||
        p31Ids.some((id) => ["Q7366", "Q134556", "Q105543609", "Q207628", "Q2188189"].includes(id));

      if (!isMusicEntity) return null;

      const extractIds = (prop) =>
        (claims[prop] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);

      const compIds = extractIds("P86");
      const lyrIds = extractIds("P676");
      const personIds = Array.from(new Set([...compIds, ...lyrIds])).slice(0, 10);

      let labelsMap = {};
      if (personIds.length) {
        const lblUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${personIds.join("|")}&props=labels&languages=pt|en&format=json&origin=*`;
        const lblData = await fetchJsonWithJsonpFallback(lblUrl, "callback");
        for (const [id, ent] of Object.entries(lblData?.entities || {})) {
          labelsMap[id] = ent.labels?.pt?.value || ent.labels?.en?.value || "";
        }
      }

      const pubTime = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time || "";
      return {
        composers: compIds.map((id) => labelsMap[id]).filter(Boolean),
        lyricists: lyrIds.map((id) => labelsMap[id]).filter(Boolean),
        year: extractYear(pubTime)
      };
    } catch {
      return null;
    }
  }

  async function fetchComposerAndOriginalMetadata(artist, title) {
    const cleanTitle = cleanTrackName(title);
    const cacheKey = `${(artist || "").toLowerCase()}|${cleanTitle.toLowerCase()}`;
    if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);

    const queries = artist && artist !== "Link Direto"
      ? [`recording:"${cleanTitle}" AND artist:"${artist}"`, `${cleanTitle} ${sanitizeSearchQuery(artist)}`]
      : [`recording:"${cleanTitle}"`, cleanTitle];

    let recordings = [];
    for (const q of queries) {
      if (!q.trim()) continue;
      try {
        const res = await fetch(
          `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=8`
        );
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.recordings?.length) {
          recordings = data.recordings;
          break;
        }
        await sleep(300);
      } catch {
        // Continua
      }
    }

    const itunesMetaPromise = fetchItunesMetadataOnly(artist === "Link Direto" ? "" : artist, cleanTitle);
    const wikidataPromise = fetchWikidataCredits(artist === "Link Direto" ? "" : artist, cleanTitle);

    const allDates = [];
    const releaseIds = [];
    for (const r of recordings) {
      if (r["first-release-date"]) allDates.push(r["first-release-date"]);
      for (const rel of r.releases || []) {
        if (rel.date) allDates.push(rel.date);
        if (rel.id) releaseIds.push(rel.id);
      }
    }

    const primaryRec = recordings[0] || null;
    const sortedTags = [...(primaryRec?.tags || [])].sort((a, b) => (b.count || 0) - (a.count || 0));

    const result = {
      recordingTitle: primaryRec?.title || title,
      performer: primaryRec?.["artist-credit"]?.map((a) => a.name).join(", ") || artist,
      originalYear: pickEarliestYear(...allDates),
      firstRelease: pickEarliestYear(...allDates) || "Não informada",
      primaryGenre: sortedTags[0]?.name ? capitalizeWords(sortedTags[0].name) : "",
      tags: sortedTags.slice(0, 5).map((t) => t.name).join(", ") || "",
      workTitle: "",
      workAnnotation: "",
      composers: [],
      lyricists: [],
      writers: [],
      arrangers: [],
      coverUrl: ""
    };

    const workPromise = (async () => {
      if (!primaryRec) return;
      try {
        await sleep(300);
        const recDetailRes = await fetch(
          `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(primaryRec.id)}?inc=work-rels+tags&fmt=json`
        );
        if (!recDetailRes.ok) return;
        const recDetail = await recDetailRes.json();

        if (!result.primaryGenre && recDetail.tags?.length) {
          const top = [...recDetail.tags].sort((a, b) => (b.count || 0) - (a.count || 0))[0];
          if (top?.name) result.primaryGenre = capitalizeWords(top.name);
        }

        const workRel = (recDetail.relations || []).find((r) => r["target-type"] === "work" && r.work?.id);
        if (!workRel) return;

        result.workTitle = workRel.work.title || "";
        await sleep(300);
        const workRes = await fetch(
          `https://musicbrainz.org/ws/2/work/${encodeURIComponent(workRel.work.id)}?inc=artist-rels+tags+annotation&fmt=json`
        );
        if (!workRes.ok) return;
        const workData = await workRes.json();

        if (workData.annotation) result.workAnnotation = String(workData.annotation).trim();

        if (!result.primaryGenre && workData.tags?.length) {
          const topW = [...workData.tags].sort((a, b) => (b.count || 0) - (a.count || 0))[0];
          if (topW?.name) result.primaryGenre = capitalizeWords(topW.name);
        }

        const composersSet = new Set();
        const lyricistsSet = new Set();
        const writersSet = new Set();
        const arrangersSet = new Set();

        for (const rel of workData.relations || []) {
          const person = rel.artist?.name;
          if (!person) continue;
          const role = (rel.type || "").toLowerCase();
          if (role === "composer") composersSet.add(person);
          else if (role === "lyricist") lyricistsSet.add(person);
          else if (role === "writer") writersSet.add(person);
          else if (role.includes("arranger") || role.includes("orchestrator")) arrangersSet.add(person);
        }

        result.composers = Array.from(composersSet);
        result.lyricists = Array.from(lyricistsSet);
        result.writers = Array.from(writersSet);
        result.arrangers = Array.from(arrangersSet);
      } catch {
        // Segue sem work
      }
    })();

    const [itMeta, wdMeta, caaCover] = await Promise.all([
      itunesMetaPromise,
      wikidataPromise,
      fetchCoverArtArchiveUrl(releaseIds),
      workPromise
    ]);

    if (wdMeta) {
      if (!result.composers.length && wdMeta.composers.length) result.composers = wdMeta.composers;
      if (!result.lyricists.length && wdMeta.lyricists.length) result.lyricists = wdMeta.lyricists;
    }

    result.originalYear = pickEarliestYear(result.originalYear, wdMeta?.year, itMeta?.year);
    if (result.originalYear) result.firstRelease = result.originalYear;
    if (!result.primaryGenre && itMeta?.genre) result.primaryGenre = itMeta.genre;

    result.coverUrl = caaCover || itMeta?.cover || "";
    if (!result.coverUrl) {
      result.coverUrl = await fetchDeezerCoverOnly(result.performer, result.recordingTitle);
    }

    metadataCache.set(cacheKey, result);
    return result;
  }

  /* =========================================================================
   * 3. MOTOR DE BUSCA MULTI-EXTENSÃO + LISTAS .M3U QUE CITEM O CANTOR
   * ========================================================================= */
  function parseM3uPlaylistText(text, baseUrl, filterTerms = []) {
    const lines = String(text || "").split(/\r?\n/);
    const entries = [];
    let pendingMeta = null;

    const matchesFilter = (str) => {
      if (!filterTerms.length) return true;
      const lower = str.toLowerCase();
      return filterTerms.some((term) => term.length >= 2 && lower.includes(term.toLowerCase()));
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#EXTINF:")) {
        const afterColon = line.slice(8);
        const commaIdx = afterColon.indexOf(",");
        const dur = commaIdx >= 0 ? parseInt(afterColon.slice(0, commaIdx), 10) : -1;
        const label = commaIdx >= 0 ? afterColon.slice(commaIdx + 1).trim() : "";
        pendingMeta = {
          duration: Number.isFinite(dur) ? dur : -1,
          label
        };
      } else if (!line.startsWith("#")) {
        let resolvedUrl = line;
        try {
          if (baseUrl && !/^https?:\/\//i.test(line)) {
            resolvedUrl = new URL(line, baseUrl).href;
          }
        } catch {
          resolvedUrl = line;
        }

        if (!/^https?:\/\//i.test(resolvedUrl)) {
          pendingMeta = null;
          continue;
        }

        const label = pendingMeta?.label || decodeURIComponent(resolvedUrl.split("/").pop() || "Faixa M3U").replace(/\.[^.]+$/, "");
        const dur = pendingMeta?.duration ?? -1;
        const searchable = `${label} ${resolvedUrl}`;

        if (matchesFilter(searchable) && !isSampleOrPreviewUrl(resolvedUrl, label) && !isSampleDuration(dur)) {
          const split = label.split(/\s+[-–—]\s+/);
          entries.push({
            title: split.length > 1 ? split.slice(1).join(" - ").trim() : label,
            artist: split.length > 1 ? split[0].trim() : filterTerms[0] || "Lista .M3U",
            url: resolvedUrl,
            durationSec: dur > 0 ? dur : -1
          });
        }
        pendingMeta = null;
      }
    }

    return entries;
  }

  async function searchM3uPlaylistsForSinger(rawQuery, cleanQuery, audioElement) {
    // Busca listas .m3u/.m3u8 no Internet Archive e Radio-Browser que citem o cantor buscado
    const singerTerms = extractSingerCandidate(rawQuery);
    const items = [];

    // Fonte A: Arquivos .m3u / .m3u8 hospedados no Internet Archive citando o cantor/música
    const archiveM3uPromise = (async () => {
      try {
        const q = `(${cleanQuery}) AND format:(M3U)`;
        const advUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier,title,creator&rows=5&page=1&output=json`;
        const advData = await fetchJsonWithJsonpFallback(advUrl, "callback");
        const docs = advData?.response?.docs || [];

        for (const doc of docs.slice(0, 4)) {
          try {
            const meta = await fetchJsonWithJsonpFallback(
              `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,
              "callback"
            );
            const m3uFile = (meta?.files || []).find((f) => /\.m3u8?$/i.test(f.name || ""));
            if (!m3uFile) continue;

            const encodedPath = m3uFile.name.split("/").map(encodeURIComponent).join("/");
            const m3uUrl = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodedPath}`;
            const res = await fetch(m3uUrl);
            if (!res.ok) continue;
            const m3uText = await res.text();

            const parsed = parseM3uPlaylistText(m3uText, m3uUrl, singerTerms);
            for (const entry of parsed.slice(0, 5)) {
              const ext = getFileExtension(entry.url);
              items.push({
                title: entry.title,
                artist: entry.artist,
                album: `Lista .M3U (${doc.title || doc.identifier})`,
                url: entry.url,
                durationSec: entry.durationSec,
                cover100: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
                cover300: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
                genre: "Lista .M3U",
                year: "",
                ext: ext ? `.${ext}` : ".m3u",
                browserPlayable: isBrowserPlayableMedia(entry.url, audioElement),
                source: "Lista .M3U"
              });
            }
          } catch {
            // Próximo doc
          }
        }
      } catch {
        // Ignora erro da fonte
      }
    })();

    // Fonte B: Radio-Browser / Listas de streams temáticos ou estações dedicadas ao cantor (retorna links .m3u / stream)
    const radioM3uPromise = (async () => {
      try {
        const primaryTerm = singerTerms[0] || cleanQuery;
        const rbUrl = `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(primaryTerm)}&limit=6&hidebroken=true`;
        const res = await fetch(rbUrl);
        if (!res.ok) return;
        const stations = await res.json();

        for (const st of stations || []) {
          const streamUrl = st.url_resolved || st.url;
          if (!streamUrl) continue;
          if (/\.(m3u|pls)$/i.test(streamUrl)) {
            // Tenta expandir o .m3u da estação
            try {
              const m3uRes = await fetch(streamUrl);
              if (m3uRes.ok) {
                const parsed = parseM3uPlaylistText(await m3uRes.text(), streamUrl, []);
                if (parsed[0]) {
                  items.push({
                    title: `${st.name} (${parsed[0].title})`,
                    artist: primaryTerm,
                    album: "Playlist .M3U Web",
                    url: parsed[0].url,
                    durationSec: -1,
                    cover100: st.favicon || "",
                    cover300: st.favicon || "",
                    genre: st.tags ? capitalizeWords(st.tags.split(",")[0]) : "Lista .M3U",
                    year: "",
                    ext: ".m3u",
                    browserPlayable: isBrowserPlayableMedia(parsed[0].url, audioElement),
                    source: "Lista .M3U"
                  });
                  continue;
                }
              }
            } catch {
              // Se CORS impedir leitura do .m3u, segue se for stream direto
            }
          } else {
            items.push({
              title: st.name || primaryTerm,
              artist: primaryTerm,
              album: "Stream Web / M3U",
              url: streamUrl,
              durationSec: -1,
              cover100: st.favicon || "",
              cover300: st.favicon || "",
              genre: st.tags ? capitalizeWords(st.tags.split(",")[0]) : "Rádio / Stream",
              year: "",
              ext: `.${(st.codec || "stream").toLowerCase()}`,
              browserPlayable: true,
              source: "Lista .M3U"
            });
          }
        }
      } catch {
        // Ignora erro
      }
    })();

    // Fonte C: Listas .m3u públicas no GitHub indexadas por código citando o cantor
    const githubM3uPromise = (async () => {
      try {
        const primaryTerm = singerTerms[0] || cleanQuery;
        const ghUrl = `https://api.github.com/search/code?q=${encodeURIComponent(`"${primaryTerm}" extension:m3u`)}&per_page=4`;
        const res = await fetch(ghUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
        if (!res.ok) return;
        const data = await res.json();

        for (const file of data?.items || []) {
          try {
            const rawUrl = file.html_url
              .replace("https://github.com/", "https://raw.githubusercontent.com/")
              .replace("/blob/", "/");
            const rawRes = await fetch(rawUrl);
            if (!rawRes.ok) continue;
            const parsed = parseM3uPlaylistText(await rawRes.text(), rawUrl, singerTerms);
            for (const entry of parsed.slice(0, 4)) {
              const ext = getFileExtension(entry.url);
              items.push({
                title: entry.title,
                artist: entry.artist,
                album: `Lista .M3U (${file.repository?.full_name || "GitHub"})`,
                url: entry.url,
                durationSec: entry.durationSec,
                cover100: "",
                cover300: "",
                genre: "Lista .M3U",
                year: "",
                ext: ext ? `.${ext}` : ".m3u",
                browserPlayable: isBrowserPlayableMedia(entry.url, audioElement),
                source: "Lista .M3U"
              });
            }
          } catch {
            // Próximo arquivo
          }
        }
      } catch {
        // GitHub Code Search pode exigir auth em algumas redes — falha silenciosa
      }
    })();

    await Promise.all([archiveM3uPromise, radioM3uPromise, githubM3uPromise]);
    return items.slice(0, 10);
  }

  async function getAudiusHost() {
    if (audiusHostCache) return audiusHostCache;
    const res = await fetch("https://api.audius.co");
    if (!res.ok) throw new Error("Audius indisponível");
    const json = await res.json();
    const hosts = json?.data || [];
    if (!hosts.length) throw new Error("Sem nós Audius");
    audiusHostCache = hosts[0];
    return audiusHostCache;
  }

  async function searchAudiusFullTracks(cleanQuery) {
    try {
      const host = await getAudiusHost();
      const url = `${host}/v1/tracks/search?query=${encodeURIComponent(cleanQuery)}&app_name=StudioFlowAudio`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = await res.json();

      const results = [];
      for (const t of json?.data || []) {
        const dur = Number(t.duration || 0);
        if (t.is_stream_gated || isSampleDuration(dur)) continue;
        const streamUrl = `${host}/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=StudioFlowAudio`;
        if (isSampleOrPreviewUrl(streamUrl, t.title || "")) continue;

        results.push({
          title: t.title || "Sem título",
          artist: t.user?.name || "Artista Independente",
          album: "Audius (Áudio Completo)",
          url: streamUrl,
          durationSec: dur,
          cover100: t.artwork?.["150x150"] || "",
          cover300: t.artwork?.["480x480"] || t.artwork?.["150x150"] || "",
          genre: t.genre || "Música",
          year: "",
          ext: ".mp3",
          browserPlayable: true,
          source: "Audius"
        });
      }
      return results.slice(0, 8);
    } catch {
      return [];
    }
  }

  async function searchArchiveAnyMediaAsAudio(rawQuery, cleanQuery, audioElement) {
    // Busca áudio e vídeo em QUALQUER extensão (.mp3, .mp4, .rma, .m4a, .flac, .rmv, .aac, .ogg, .wav, .wma, etc.)
    try {
      const split = splitArtistTitleFromQuery(rawQuery);
      const luceneQueries = split
        ? [
            `((${sanitizeSearchQuery(split.partA)}) AND (${sanitizeSearchQuery(split.partB)})) AND (mediatype:(audio) OR mediatype:(movies))`,
            `(${cleanQuery}) AND (mediatype:(audio) OR mediatype:(movies))`
          ]
        : [`(${cleanQuery}) AND (mediatype:(audio) OR mediatype:(movies))`];

      let docs = [];
      for (const lq of luceneQueries) {
        const advUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(lq)}&fl[]=identifier,title,creator,year,subject,mediatype&rows=10&page=1&output=json`;
        const advData = await fetchJsonWithJsonpFallback(advUrl, "callback");
        if (advData?.response?.docs?.length) {
          docs = advData.response.docs;
          break;
        }
      }
      if (!docs.length) return [];

      const detailPromises = docs.slice(0, 8).map(async (doc) => {
        try {
          const meta = await fetchJsonWithJsonpFallback(
            `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,
            "callback"
          );
          const files = meta?.files || [];

          const validMediaFiles = files.filter((f) => {
            if (!f.name || !ANY_MEDIA_EXT_REGEX.test(f.name)) return false;
            if (/sample|preview|clip/i.test(f.name)) return false;
            const dur = parseDurationSeconds(f.length);
            return dur === 0 || dur >= MIN_FULL_TRACK_SECONDS;
          });

          if (!validMediaFiles.length) return null;

          // Prioriza formatos reproduzíveis nativamente no navegador (.mp3, .m4a, .aac, .ogg, .flac, .mp4, .webm)
          // mas mantém .rma, .rmv, .wma, etc. caso sejam os únicos disponíveis
          validMediaFiles.sort((a, b) => {
            const extA = getFileExtension(a.name);
            const extB = getFileExtension(b.name);
            const idxA = BROWSER_PLAYABLE_EXT_PRIORITY.indexOf(extA);
            const idxB = BROWSER_PLAYABLE_EXT_PRIORITY.indexOf(extB);
            const rankA = idxA === -1 ? 99 : idxA;
            const rankB = idxB === -1 ? 99 : idxB;
            return rankA - rankB;
          });

          const chosen = validMediaFiles[0];
          const encodedPath = chosen.name.split("/").map(encodeURIComponent).join("/");
          const fileUrl = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodedPath}`;
          if (isSampleOrPreviewUrl(fileUrl, chosen.title || doc.title || "")) return null;

          const durSec = parseDurationSeconds(chosen.length);
          if (isSampleDuration(durSec)) return null;

          const ext = getFileExtension(chosen.name);
          const playable = isBrowserPlayableMedia(chosen.name, audioElement);
          const creator = Array.isArray(doc.creator) ? doc.creator.join(", ") : doc.creator;
          const rawSubj = Array.isArray(doc.subject) ? doc.subject[0] : doc.subject;
          const genreVal = chosen.genre || (rawSubj ? String(rawSubj).split(";")[0].trim() : "") || "Acervo Completo";

          return {
            title: chosen.title || doc.title || doc.identifier,
            artist: chosen.artist || chosen.creator || creator || "Acervo Aberto",
            album: `Archive.org (${ext.toUpperCase()})`,
            url: fileUrl,
            durationSec: durSec,
            cover100: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
            cover300: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
            genre: genreVal,
            year: "",
            ext: `.${ext}`,
            browserPlayable: playable,
            source: `Archive (.${ext})`
          };
        } catch {
          return null;
        }
      });

      return (await Promise.all(detailPromises)).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function searchWikimediaMediaAsAudio(cleanQuery, audioElement) {
    try {
      const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(cleanQuery + " (filetype:audio OR filetype:video)")}&gsrlimit=8&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&origin=*`;
      const data = await fetchJsonWithJsonpFallback(apiUrl, "callback");
      const pages = Object.values(data?.query?.pages || {});
      const items = [];

      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info?.url) continue;

        const dur = Number(info.duration || 0);
        if (isSampleDuration(dur)) continue;

        const ext = getFileExtension(info.url);
        const rawTitle = (page.title || "").replace(/^File:/i, "").replace(/\.[^.]+$/, "").replace(/_/g, " ");
        const artistMeta = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").trim() || "Domínio Público / CC";

        items.push({
          title: rawTitle || "Áudio Wikimedia",
          artist: artistMeta.slice(0, 60),
          album: `Wikimedia (.${ext || "audio"})`,
          url: info.url,
          durationSec: Math.round(dur),
          cover100: "",
          cover300: "",
          genre: "Acervo Aberto",
          year: "",
          ext: ext ? `.${ext}` : ".ogg",
          browserPlayable: isBrowserPlayableMedia(info.url, audioElement),
          source: `Wikimedia (.${ext || "ogg"})`
        });
      }
      return items.slice(0, 6);
    } catch {
      return [];
    }
  }

  async function searchMusicBrainzOfficialStreams(rawQuery, cleanQuery) {
    try {
      const split = splitArtistTitleFromQuery(rawQuery);
      const mbQueries = split
        ? [
            `recording:"${split.partA}" AND artist:"${split.partB}"`,
            `recording:"${split.partB}" AND artist:"${split.partA}"`,
            cleanQuery
          ]
        : [cleanQuery];

      let recordings = [];
      for (const q of mbQueries) {
        const res = await fetch(
          `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=4`
        );
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.recordings?.length) {
          recordings = data.recordings;
          break;
        }
        await sleep(300);
      }
      if (!recordings.length) return [];

      const earliestYear = pickEarliestYear(
        ...recordings.flatMap((r) => [r["first-release-date"], ...(r.releases || []).map((rel) => rel.date)])
      );

      const items = [];
      for (const rec of recordings.slice(0, 2)) {
        await sleep(350);
        const detRes = await fetch(
          `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(rec.id)}?inc=url-rels+tags&fmt=json`
        );
        if (!detRes.ok) continue;
        const det = await detRes.json();

        for (const rel of det.relations || []) {
          const resUrl = rel.url?.resource;
          if (!resUrl) continue;
          const embed = parseOfficialEmbed(resUrl);
          if (!embed && !/archive\.org\/download/i.test(resUrl)) continue;

          const artistName = rec["artist-credit"]?.map((a) => a.name).join(", ") || "Artista";
          const topTag = [...(det.tags || rec.tags || [])].sort((a, b) => (b.count || 0) - (a.count || 0))[0];

          items.push({
            title: rec.title || cleanQuery,
            artist: artistName,
            album: embed ? `Streaming Oficial (${embed.provider})` : "MusicBrainz Link",
            url: resUrl,
            durationSec: rec.length ? Math.round(rec.length / 1000) : 180,
            cover100: "",
            cover300: "",
            genre: topTag?.name ? capitalizeWords(topTag.name) : "Streaming Oficial",
            year: earliestYear,
            ext: embed ? embed.provider : ".mp3",
            browserPlayable: true,
            source: embed ? embed.provider : "MusicBrainz"
          });
          break;
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  async function searchAllFullTracks(rawQuery, audioElement) {
    const cleanQuery = sanitizeSearchQuery(rawQuery);
    if (!cleanQuery) return [];

    const [audiusItems, archiveItems, wikiItems, mbStreamItems, m3uItems] = await Promise.all([
      searchAudiusFullTracks(cleanQuery),
      searchArchiveAnyMediaAsAudio(rawQuery, cleanQuery, audioElement),
      searchWikimediaMediaAsAudio(cleanQuery, audioElement),
      searchMusicBrainzOfficialStreams(rawQuery, cleanQuery),
      searchM3uPlaylistsForSinger(rawQuery, cleanQuery, audioElement)
    ]);

    const seenUrls = new Set();
    const combined = [...mbStreamItems, ...audiusItems, ...archiveItems, ...m3uItems, ...wikiItems].filter((item) => {
      if (!item.url || seenUrls.has(item.url)) return false;
      if (isSampleOrPreviewUrl(item.url, item.title) || isSampleDuration(item.durationSec)) return false;
      seenUrls.add(item.url);
      return true;
    });

    await Promise.all(
      combined.slice(0, 8).map(async (item) => {
        if (!item.cover100 || !item.year) {
          const itMeta = await fetchItunesMetadataOnly(item.artist, item.title);
          if (itMeta) {
            if (!item.cover100 && itMeta.cover) {
              item.cover100 = itMeta.cover;
              item.cover300 = itMeta.cover;
            }
            if (!item.year && itMeta.year) item.year = itMeta.year;
            if (isGenericGenre(item.genre) && itMeta.genre) item.genre = itMeta.genre;
          }
        }
      })
    );

    return combined;
  }

  async function fetchLyrics(artist, title) {
    const cleanTitle = cleanTrackName(title);
    const apiUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist)}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const found = Array.isArray(list) ? list.find((x) => x.plainLyrics || x.syncedLyrics) : null;
    if (!found) return "";
    return (found.plainLyrics || found.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")).trim();
  }

  /* =========================================================================
   * 4. BUSCA ESTRITA DE HISTÓRIA DA COMPOSIÇÃO / COMPOSITOR / LETRISTA
   * ========================================================================= */
  function isRelevantCompositionArticle(wikiTitle, extract, songTitle, peopleNames = []) {
    const hay = `${wikiTitle} ${extract}`.toLowerCase();
    const cleanSong = cleanTrackName(songTitle).toLowerCase();

    const hasSongToken = cleanSong.length >= 3 && hay.includes(cleanSong);
    const hasMusicKeyword =
      /(canção|música|composição|compositor|letrista|composta|letra|álbum|disco|gravação|single|song|composed|written by|lyrics|lyricist|recorded|track|canción|compuesta|chanson|brano|lied)/i.test(
        hay
      );
    const hasPersonMatch = peopleNames
      .filter((n) => n && n.length >= 3)
      .some((n) => hay.includes(n.toLowerCase()));

    return hasSongToken && hasMusicKeyword && (hasPersonMatch || peopleNames.length === 0);
  }

  function isRelevantPersonArticle(wikiTitle, extract, personName) {
    const hay = `${wikiTitle} ${extract}`.toLowerCase();
    const cleanPerson = personName.toLowerCase().trim();
    const hasName = cleanPerson.length >= 3 && hay.includes(cleanPerson);
    const isMusician =
      /(compositor|letrista|músico|cantor|cantora|composer|lyricist|songwriter|musician|singer|banda|band|cantautor)/i.test(
        hay
      );
    return hasName && isMusician;
  }

  async function fetchWikipediaSummaryRaw(query, lang = "pt") {
    const baseApi = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts|info|pageimages&pithumbsize=500&inprop=url&exintro=1&explaintext=1&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=2&format=json`;
    let data = null;

    try {
      const res = await fetch(`${baseApi}&origin=*`);
      if (res.ok) data = await res.json();
    } catch {
      // Fallback JSONP
    }
    if (!data) {
      try {
        data = await jsonpRequest(baseApi, "callback");
      } catch {
        return [];
      }
    }

    return Object.values(data?.query?.pages || {})
      .filter((p) => p && p.extract)
      .map((p) => ({
        title: p.title,
        extract: p.extract.trim(),
        thumbnail: p.thumbnail?.source || "",
        url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
        lang
      }));
  }

  async function findVerifiedCompositionHistory(songTitle, peopleNames) {
    const cleanTitle = cleanTrackName(songTitle);
    const refPerson = peopleNames[0] || "";
    const candidatesQueries = [
      { lang: "pt", q: `"${cleanTitle}" "${refPerson}" canção` },
      { lang: "pt", q: `${cleanTitle} ${refPerson} música` },
      { lang: "en", q: `"${cleanTitle}" "${refPerson}" song` },
      { lang: "es", q: `"${cleanTitle}" "${refPerson}" canción` },
      { lang: "fr", q: `"${cleanTitle}" "${refPerson}" chanson` },
      { lang: "it", q: `"${cleanTitle}" "${refPerson}" brano` }
    ];

    for (const item of candidatesQueries) {
      if (!cleanTitle) continue;
      const pages = await fetchWikipediaSummaryRaw(item.q, item.lang);
      const valid = pages.find((p) => isRelevantCompositionArticle(p.title, p.extract, cleanTitle, peopleNames));
      if (valid) {
        let finalText = valid.extract;
        let autoTranslated = false;
        if (valid.lang !== "pt") {
          try {
            const tr = await translateTextToPtBr(valid.extract.slice(0, 1400), valid.lang);
            finalText = tr.translated;
            autoTranslated = true;
          } catch {
            // Mantém original se cota acabar
          }
        }
        return { ...valid, extract: finalText, autoTranslated };
      }
    }
    return null;
  }

  async function findVerifiedComposerBio(personName) {
    if (!personName) return null;
    const queries = [
      { lang: "pt", q: `"${personName}" compositor` },
      { lang: "pt", q: `${personName} músico` },
      { lang: "en", q: `"${personName}" songwriter composer` },
      { lang: "es", q: `"${personName}" compositor` }
    ];

    for (const item of queries) {
      const pages = await fetchWikipediaSummaryRaw(item.q, item.lang);
      const valid = pages.find((p) => isRelevantPersonArticle(p.title, p.extract, personName));
      if (valid) {
        let finalText = valid.extract;
        let autoTranslated = false;
        if (valid.lang !== "pt") {
          try {
            const tr = await translateTextToPtBr(valid.extract.slice(0, 1400), valid.lang);
            finalText = tr.translated;
            autoTranslated = true;
          } catch {
            // Mantém original
          }
        }
        return { ...valid, extract: finalText, autoTranslated };
      }
    }
    return null;
  }

  /* =========================================================================
   * 5. MOTOR VISUAL SPECTRUM DE ESTÚDIO (6 MODOS, SEM VÍNCULO COM <audio>)
   * ========================================================================= */
  const GENRE_PROFILES = [
    {
      match: /rock|metal|punk|grunge|hard/i,
      label: "Rock / Energia",
      preferredMode: "winamp",
      tempoMul: 1.35,
      colors: ["#ff2a54", "#ff8c00", "#ffd166"],
      aura1: "rgba(255, 42, 84, 0.28)",
      aura2: "rgba(255, 140, 0, 0.20)"
    },
    {
      match: /electronic|techno|house|trance|edm|synth|dubstep|electro/i,
      label: "Eletrônica / Cyber",
      preferredMode: "mirrored",
      tempoMul: 1.5,
      colors: ["#00f5d4", "#7b2cbf", "#f72585"],
      aura1: "rgba(0, 245, 212, 0.26)",
      aura2: "rgba(247, 37, 133, 0.22)"
    },
    {
      match: /jazz|blues|soul|r&b|lo-fi|lounge/i,
      label: "Jazz / Fluidez",
      preferredMode: "aurora",
      tempoMul: 0.85,
      colors: ["#f4a261", "#2a9d8f", "#60a5fa"],
      aura1: "rgba(244, 162, 97, 0.24)",
      aura2: "rgba(42, 157, 143, 0.22)"
    },
    {
      match: /classical|clássica|orchestra|piano|ambient|instrumental|folk/i,
      label: "Clássica / Cósmica",
      preferredMode: "reactor",
      tempoMul: 0.72,
      colors: ["#38bdf8", "#a78bfa", "#e0f2fe"],
      aura1: "rgba(56, 189, 248, 0.26)",
      aura2: "rgba(167, 139, 250, 0.22)"
    },
    {
      match: /hip-hop|rap|trap|funk|bass/i,
      label: "Hip-Hop / Grave",
      preferredMode: "reactor",
      tempoMul: 1.25,
      colors: ["#a855f7", "#22ff88", "#f97316"],
      aura1: "rgba(168, 85, 247, 0.28)",
      aura2: "rgba(34, 255, 136, 0.18)"
    },
    {
      match: /pop|mpb|samba|bossa|reggae|latin|indie|romântic/i,
      label: "MPB / Vibrante",
      preferredMode: "mirrored",
      tempoMul: 1.12,
      colors: ["#22d3ee", "#10b981", "#fb7185"],
      aura1: "rgba(34, 211, 238, 0.25)",
      aura2: "rgba(251, 113, 133, 0.20)"
    }
  ];

  const DEFAULT_PROFILE = {
    label: "Studio / Spectrum",
    preferredMode: "winamp",
    tempoMul: 1.0,
    colors: ["#22ff88", "#22d3ee", "#8b5cf6"],
    aura1: "rgba(34, 211, 238, 0.22)",
    aura2: "rgba(139, 92, 246, 0.18)"
  };

  class VisualizerEngine {
    constructor(canvas, audioElement, hudBadgeEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.audio = audioElement;
      this.hudBadge = hudBadgeEl;

      this.mode = "auto";
      this.profile = DEFAULT_PROFILE;
      this.isPlaying = false;
      this.phase = 0;
      this.barCount = 60;
      this.bars = new Float32Array(this.barCount);
      this.peaks = new Float32Array(this.barCount);
      this.peakHold = new Float32Array(this.barCount);
      this.coverImg = null;

      this.particles = Array.from({ length: 72 }, (_, i) => ({
        angle: (i / 72) * Math.PI * 2,
        radius: 0.22 + Math.random() * 0.78,
        speed: 0.004 + Math.random() * 0.012,
        size: 1.4 + Math.random() * 2.6
      }));

      this.resizeCanvas();
      window.addEventListener("resize", () => this.resizeCanvas());
      this.startLoop();
    }

    resizeCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(rect.width * dpr);
      this.canvas.height = Math.floor(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = rect.width;
      this.height = rect.height;
    }

    setMode(mode) {
      this.mode = mode;
      this.updateHudLabel();
    }

    setPlaying(playing) {
      this.isPlaying = playing;
      this.updateHudLabel();
    }

    setCoverImage(url) {
      if (!url || url.startsWith("data:")) {
        this.coverImg = null;
        return;
      }
      const img = new Image();
      img.onload = () => { this.coverImg = img; };
      img.onerror = () => { this.coverImg = null; };
      img.src = url;
    }

    setTrackMood(genre = "", title = "") {
      const matched = GENRE_PROFILES.find((p) => p.match.test(`${genre} ${title}`));
      this.profile = matched || DEFAULT_PROFILE;
      document.documentElement.style.setProperty("--aura-primary", this.profile.aura1);
      document.documentElement.style.setProperty("--aura-secondary", this.profile.aura2);
      this.updateHudLabel();
    }

    resolveActiveStyle() {
      if (this.mode !== "auto") return this.mode;
      if (!this.isPlaying) return this.profile.preferredMode;
      const styles = [this.profile.preferredMode, "mirrored", "reactor", "aurora", "cyber", "oscilloscope", "winamp"];
      const t = this.audio.currentTime || 0;
      return styles[Math.floor(t / 22) % styles.length];
    }

    updateHudLabel() {
      if (!this.hudBadge) return;
      const active = this.resolveActiveStyle();
      const names = {
        winamp: "Winamp LED + Reflexo",
        mirrored: "Dual Symmetrical",
        reactor: "Circular Reactor",
        aurora: "Aurora Waves",
        cyber: "Cyber Grid 3D",
        oscilloscope: "CRT Oscilloscope"
      };
      this.hudBadge.textContent = `${this.profile.label} • ${names[active] || active}`;
    }

    sampleEnergyBars() {
      const rate = this.audio.playbackRate || 1;
      const volGain = this.audio.muted ? 0.12 : Math.max(0.2, this.audio.volume || 0.95);
      const speed = this.profile.tempoMul * rate;
      const songTime = this.isPlaying ? (this.audio.currentTime || this.phase) : 0;

      for (let i = 0; i < this.barCount; i++) {
        let target = 0.04;
        if (this.isPlaying) {
          const norm = i / this.barCount;
          const bassKick = Math.pow(Math.max(0, Math.sin(songTime * 4.5 * speed)), 4) * (1 - norm) * 0.78;
          const midHarm = Math.abs(Math.sin(songTime * 2.8 * speed + i * 0.28)) * 0.42;
          const highSpark = Math.abs(Math.cos(songTime * 6.8 * speed - i * 0.55)) * norm * 0.36;
          target = Math.min(0.98, (0.1 + bassKick + midHarm + highSpark) * volGain);
        } else {
          target = 0.03 + Math.max(0, Math.sin(this.phase * 1.4 + i * 0.22)) * 0.035;
        }
        this.bars[i] += (target - this.bars[i]) * (this.isPlaying ? 0.3 : 0.12);
      }

      for (let i = 0; i < this.barCount; i++) {
        if (this.bars[i] >= this.peaks[i]) {
          this.peaks[i] = this.bars[i];
          this.peakHold[i] = 16;
        } else if (this.peakHold[i] > 0) {
          this.peakHold[i]--;
        } else {
          this.peaks[i] = Math.max(0, this.peaks[i] - 0.016);
        }
      }

      let total = 0;
      for (let i = 0; i < this.barCount; i++) total += this.bars[i];
      return total / this.barCount;
    }

    startLoop() {
      const render = () => {
        this.phase += this.isPlaying ? 0.032 * this.profile.tempoMul : 0.01;
        if (!this.width || !this.height) this.resizeCanvas();

        const avgEnergy = this.sampleEnergyBars();
        const style = this.resolveActiveStyle();
        if (this.isPlaying && Math.floor(this.phase * 10) % 25 === 0) {
          this.updateHudLabel();
        }

        const ctx = this.ctx;
        const w = this.width || 700;
        const h = this.height || 230;

        ctx.fillStyle = style === "reactor" || style === "cyber" ? "rgba(3, 6, 12, 0.32)" : "rgba(3, 6, 12, 0.58)";
        ctx.fillRect(0, 0, w, h);

        if (style === "winamp") this.drawWinampLedWithReflection(ctx, w, h, avgEnergy);
        else if (style === "mirrored") this.drawDualSymmetricalGlow(ctx, w, h, avgEnergy);
        else if (style === "reactor") this.drawCircularBassReactor(ctx, w, h, avgEnergy);
        else if (style === "aurora") this.drawHarmonicAuroraWaves(ctx, w, h, avgEnergy);
        else if (style === "cyber") this.drawCyberGridAndTunnel(ctx, w, h, avgEnergy);
        else this.drawCrtOscilloscope(ctx, w, h, avgEnergy);

        requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
    }

    drawWinampLedWithReflection(ctx, w, h, energy) {
      const [c1, c2, c3] = this.profile.colors;
      const padX = 12;
      const step = (w - padX * 2) / this.barCount;
      const barW = Math.max(3, step - 2.5);
      const baseLine = h * 0.74;
      const maxH = baseLine - 18;

      ctx.save();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
      ctx.lineWidth = 1;
      for (let gy = 24; gy < baseLine; gy += 24) {
        ctx.beginPath();
        ctx.moveTo(padX, gy);
        ctx.lineTo(w - padX, gy);
        ctx.stroke();
      }
      ctx.restore();

      const grad = ctx.createLinearGradient(0, baseLine, 0, 18);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.55, c2);
      grad.addColorStop(1, c3);

      for (let i = 0; i < this.barCount; i++) {
        const x = padX + i * step;
        const barH = Math.max(4, this.bars[i] * maxH);
        const y = baseLine - barH;

        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);

        ctx.fillStyle = "rgba(3, 6, 12, 0.68)";
        for (let segY = baseLine; segY > y; segY -= 6) {
          ctx.fillRect(x, segY - 2, barW, 2);
        }

        ctx.save();
        ctx.globalAlpha = 0.24;
        ctx.fillStyle = c1;
        ctx.fillRect(x, baseLine + 3, barW, barH * 0.28);
        ctx.restore();

        const peakY = baseLine - this.peaks[i] * maxH;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, peakY - 3, barW, 2.5);
      }

      ctx.fillStyle = this.profile.aura1;
      ctx.fillRect(padX, baseLine, w - padX * 2, 1.5 + energy * 1.5);
    }

    drawDualSymmetricalGlow(ctx, w, h, energy) {
      const [c1, c2, c3] = this.profile.colors;
      const midY = h * 0.46;
      const padX = 14;
      const step = (w - padX * 2) / this.barCount;
      const barW = Math.max(3, step - 3);
      const maxHalf = h * 0.36;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      const gradUp = ctx.createLinearGradient(0, midY, 0, midY - maxHalf);
      gradUp.addColorStop(0, c1);
      gradUp.addColorStop(0.55, c2);
      gradUp.addColorStop(1, c3);

      for (let i = 0; i < this.barCount; i++) {
        const x = padX + i * step;
        const bh = Math.max(3, this.bars[i] * maxHalf);

        ctx.shadowColor = c2;
        ctx.shadowBlur = 12;
        ctx.fillStyle = gradUp;
        ctx.fillRect(x, midY - bh, barW, bh);

        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, midY + 2, barW, bh * 0.78);
        ctx.globalAlpha = 1;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, midY - this.peaks[i] * maxHalf - 3, barW, 2);
      }

      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.35 + energy * 0.4;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padX, midY);
      ctx.lineTo(w - padX, midY);
      ctx.stroke();
      ctx.restore();
    }

    drawCircularBassReactor(ctx, w, h, energy) {
      const [c1, c2, c3] = this.profile.colors;
      const cx = w / 2;
      const cy = h * 0.47;
      const bass = (this.bars[0] + this.bars[1] + this.bars[2]) / 3;
      const coreR = Math.min(w, h) * 0.16 + bass * 18;

      const radGrad = ctx.createRadialGradient(cx, cy, coreR * 0.4, cx, cy, coreR * 2.8);
      radGrad.addColorStop(0, c1);
      radGrad.addColorStop(0.45, c2);
      radGrad.addColorStop(1, "transparent");
      ctx.save();
      ctx.globalAlpha = 0.35 + energy * 0.45;
      ctx.fillStyle = radGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 2.6;
      const needles = 72;
      for (let i = 0; i < needles; i++) {
        const barIdx = Math.floor((i / needles) * this.barCount);
        const ang = (i / needles) * Math.PI * 2 + this.phase * 0.35;
        const r1 = coreR + 6;
        const r2 = r1 + this.bars[barIdx] * Math.min(w, h) * 0.3;
        ctx.strokeStyle = i % 3 === 0 ? c1 : i % 3 === 1 ? c2 : c3;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(this.isPlaying ? this.phase * 0.6 : 0);
      if (this.coverImg) {
        ctx.drawImage(this.coverImg, -coreR, -coreR, coreR * 2, coreR * 2);
      } else {
        const discGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, coreR);
        discGrad.addColorStop(0, "#ffffff");
        discGrad.addColorStop(0.3, c1);
        discGrad.addColorStop(1, "#05090e");
        ctx.fillStyle = discGrad;
        ctx.fillRect(-coreR, -coreR, coreR * 2, coreR * 2);
      }
      ctx.restore();

      ctx.strokeStyle = c3;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.stroke();

      this.particles.forEach((p, idx) => {
        p.angle += p.speed * (1 + energy * 2.8);
        const dist = p.radius * Math.min(w, h) * 0.48 * (0.88 + bass * 0.25);
        const px = cx + Math.cos(p.angle) * dist * 1.45;
        const py = cy + Math.sin(p.angle) * dist * 0.78;
        ctx.fillStyle = idx % 2 === 0 ? c1 : c3;
        ctx.beginPath();
        ctx.arc(px, py, p.size * (0.7 + energy), 0, Math.PI * 2);
        ctx.fill();
      });
    }

    drawHarmonicAuroraWaves(ctx, w, h, energy) {
      const [c1, c2, c3] = this.profile.colors;
      const baseY = h * 0.56;
      const layers = [
        { color: c1, amp: 24 + energy * 62, freq: 0.018, speed: 1.4, alpha: 0.26 },
        { color: c2, amp: 20 + energy * 48, freq: 0.028, speed: -1.9, alpha: 0.22 },
        { color: c3, amp: 14 + energy * 36, freq: 0.042, speed: 2.5, alpha: 0.2 }
      ];

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      layers.forEach((layer, idx) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 6) {
          const barIdx = Math.min(this.barCount - 1, Math.floor((x / w) * this.barCount));
          const boost = 0.55 + this.bars[barIdx] * 0.95;
          const y = baseY + Math.sin(x * layer.freq + this.phase * layer.speed + idx * 1.4) * layer.amp * boost;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();

        const fillGrad = ctx.createLinearGradient(0, baseY - 70, 0, h);
        fillGrad.addColorStop(0, layer.color);
        fillGrad.addColorStop(1, "transparent");
        ctx.globalAlpha = layer.alpha;
        ctx.fillStyle = fillGrad;
        ctx.fill();

        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = layer.color;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      });
      ctx.restore();
    }

    drawCyberGridAndTunnel(ctx, w, h, energy) {
      const [c1, c2, c3] = this.profile.colors;
      const horizonY = h * 0.44;

      ctx.save();
      ctx.strokeStyle = c2;
      ctx.globalAlpha = 0.35 + energy * 0.35;
      ctx.lineWidth = 1;
      for (let i = -8; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(w / 2 + i * 18, horizonY);
        ctx.lineTo(w / 2 + i * 110, h);
        ctx.stroke();
      }
      for (let row = 0; row < 7; row++) {
        const prog = ((row / 7) + this.phase * 0.35) % 1;
        const y = horizonY + Math.pow(prog, 2) * (h - horizonY);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.restore();

      const cx = w / 2;
      const cy = horizonY * 0.65;
      for (let r = 0; r < 7; r++) {
        const progress = ((r / 7) + this.phase * 0.2) % 1;
        const radius = progress * Math.max(w, h) * 0.42;
        ctx.save();
        ctx.strokeStyle = r % 3 === 0 ? c1 : r % 3 === 1 ? c2 : c3;
        ctx.globalAlpha = (1 - progress) * (0.4 + energy * 0.6);
        ctx.lineWidth = 1.5 + progress * 2;
        ctx.beginPath();
        for (let s = 0; s <= 6; s++) {
          const a = (s / 6) * Math.PI * 2 + this.phase * 0.4 + r * 0.2;
          const x = cx + Math.cos(a) * radius * 1.3;
          const y = cy + Math.sin(a) * radius * 0.7;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    drawCrtOscilloscope(ctx, w, h, energy) {
      const [c1, c2] = this.profile.colors;
      const midY = h * 0.47;

      ctx.save();
      ctx.strokeStyle = "rgba(34, 255, 136, 0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = c1;
      ctx.shadowColor = c2;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const barIdx = Math.min(this.barCount - 1, Math.floor((x / w) * this.barCount));
        const val = this.bars[barIdx];
        const y =
          midY +
          Math.sin(x * 0.06 + this.phase * 4.5) * val * (h * 0.34) +
          Math.cos(x * 0.13 - this.phase * 3) * energy * 18;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /* =========================================================================
   * 6. CONTROLADOR PRINCIPAL
   * ========================================================================= */
  const state = {
    currentTrack: {
      title: "",
      artist: "",
      album: "",
      url: "",
      durationSec: 0,
      cover: "",
      genre: "",
      originalYear: "",
      isEmbed: false
    },
    lastSearchCount: 0,
    isResultsCollapsed: false,
    m3uTracks: [],
    isSeeking: false
  };

  const el = {
    searchForm: document.getElementById("searchForm"),
    searchInput: document.getElementById("searchInput"),
    searchResults: document.getElementById("searchResults"),
    resultsCount: document.getElementById("resultsCount"),
    toggleResultsBtn: document.getElementById("toggleResultsBtn"),
    resultsCollapsedBar: document.getElementById("resultsCollapsedBar"),
    collapsedActiveText: document.getElementById("collapsedActiveText"),
    expandFromBarBtn: document.getElementById("expandFromBarBtn"),
    resultsBody: document.getElementById("resultsBody"),

    playerCard: document.getElementById("playerCard"),
    directLinkForm: document.getElementById("directLinkForm"),
    directUrlInput: document.getElementById("directUrlInput"),
    directTitleInput: document.getElementById("directTitleInput"),
    directArtistInput: document.getElementById("directArtistInput"),

    nativeControlsBox: document.getElementById("nativeControlsBox"),
    embedContainer: document.getElementById("embedContainer"),
    audio: document.getElementById("audioPlayer"),
    playPauseBtn: document.getElementById("playPauseBtn"),
    stopBtn: document.getElementById("stopBtn"),
    seekBar: document.getElementById("seekBar"),
    currentTimeLabel: document.getElementById("currentTimeLabel"),
    durationLabel: document.getElementById("durationLabel"),
    lcdClock: document.getElementById("lcdClock"),
    lcdDurationSmall: document.getElementById("lcdDurationSmall"),
    lcdBitrate: document.getElementById("lcdBitrate"),
    marqueeText: document.getElementById("marqueeText"),
    muteBtn: document.getElementById("muteBtn"),
    volumeBar: document.getElementById("volumeBar"),
    speedSelect: document.getElementById("speedSelect"),
    loopBtn: document.getElementById("loopBtn"),
    playerStatus: document.getElementById("playerStatus"),

    visualizerStage: document.getElementById("visualizerStage"),
    visualizerCanvas: document.getElementById("visualizerCanvas"),
    vizMoodBadge: document.getElementById("vizMoodBadge"),
    vizModeSelect: document.getElementById("vizModeSelect"),
    toggleImmersionBtn: document.getElementById("toggleImmersionBtn"),

    trackCover: document.getElementById("trackCover"),
    trackGenre: document.getElementById("trackGenre"),
    trackTitle: document.getElementById("trackTitle"),
    trackArtist: document.getElementById("trackArtist"),
    addCurrentToM3uBtn: document.getElementById("addCurrentToM3uBtn"),

    detectedLangBadge: document.getElementById("detectedLangBadge"),
    fetchLyricsBtn: document.getElementById("fetchLyricsBtn"),
    translateBtn: document.getElementById("translateBtn"),
    clearLyricsBtn: document.getElementById("clearLyricsBtn"),
    lyricsText: document.getElementById("lyricsText"),
    translationOutput: document.getElementById("translationOutput"),
    googleTranslateFallback: document.getElementById("googleTranslateFallback"),
    lyricsStatus: document.getElementById("lyricsStatus"),

    refreshHistoryBtn: document.getElementById("refreshHistoryBtn"),
    historyContent: document.getElementById("historyContent"),

    m3uCustomTitle: document.getElementById("m3uCustomTitle"),
    m3uCustomGenre: document.getElementById("m3uCustomGenre"),
    m3uCustomYear: document.getElementById("m3uCustomYear"),
    m3uCustomUrl: document.getElementById("m3uCustomUrl"),
    m3uAddCustomBtn: document.getElementById("m3uAddCustomBtn"),
    m3uList: document.getElementById("m3uList"),
    m3uPreview: document.getElementById("m3uPreview"),
    copyM3uBtn: document.getElementById("copyM3uBtn"),
    downloadM3uBtn: document.getElementById("downloadM3uBtn"),
    clearM3uBtn: document.getElementById("clearM3uBtn")
  };

  el.trackCover.addEventListener("error", () => {
    if (el.trackCover.src !== DEFAULT_COVER_SVG) {
      el.trackCover.src = DEFAULT_COVER_SVG;
      visualizer.setCoverImage("");
    }
  });

  const visualizer = new VisualizerEngine(el.visualizerCanvas, el.audio, el.vizMoodBadge);

  el.vizModeSelect.addEventListener("change", () => visualizer.setMode(el.vizModeSelect.value));

  function setImmersionExpanded(expanded) {
    el.visualizerStage.classList.toggle("immersion-expanded", expanded);
    el.toggleImmersionBtn.textContent = expanded ? "✕ Fechar" : "⛶ Imersão";
    setTimeout(() => visualizer.resizeCanvas(), 50);
  }

  el.toggleImmersionBtn.addEventListener("click", () => {
    setImmersionExpanded(!el.visualizerStage.classList.contains("immersion-expanded"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.visualizerStage.classList.contains("immersion-expanded")) {
      setImmersionExpanded(false);
    }
  });

  el.playerCard.addEventListener("contextmenu", (e) => {
    if (e.target.tagName !== "INPUT") e.preventDefault();
  });

  function ensureAudioOutputReady() {
    el.audio.defaultMuted = false;
    el.audio.muted = false;
    const vol = Number(el.volumeBar.value);
    el.audio.volume = Number.isFinite(vol) && vol > 0 ? vol : 0.95;
    el.muteBtn.setAttribute("aria-pressed", "false");
    el.muteBtn.textContent = "Som: Ligado";
  }

  ensureAudioOutputReady();

  function setPlayerStatus(msg, isError = false) {
    el.playerStatus.textContent = msg;
    el.playerStatus.title = msg;
    el.playerStatus.classList.toggle("status-error", isError);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "00:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateClockDisplays(currentSec, durationSec) {
    const curStr = formatTime(currentSec);
    const durStr = Number.isFinite(durationSec) && durationSec > 0 ? formatTime(durationSec) : "STREAM";
    el.currentTimeLabel.textContent = curStr;
    el.lcdClock.textContent = curStr;
    el.durationLabel.textContent = durStr;
    el.lcdDurationSmall.textContent = `/ ${durStr}`;
  }

  function applyTrackCover(url) {
    el.trackCover.src = url || DEFAULT_COVER_SVG;
    visualizer.setCoverImage(url || "");
  }

  function updateTrackBadgeAndMarquee() {
    const t = state.currentTrack;
    const g = t.genre || "Somente Áudio";
    const y = t.originalYear ? ` • Original: ${t.originalYear}` : "";
    el.trackGenre.textContent = `${g}${y}`;

    if (t.title) {
      el.marqueeText.textContent = `*** ${t.artist || "ARTISTA"} — ${t.title} [${g}${y}] *** SOMENTE ÁUDIO COMPLETO ***`;
    }
    visualizer.setTrackMood(t.genre, t.title);
  }

  function showEmptyMessage(container, message) {
    container.innerHTML = "";
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = message;
    container.appendChild(div);
  }

  function setResultsCollapsed(collapsed) {
    state.isResultsCollapsed = collapsed;
    el.resultsBody.hidden = collapsed;
    el.resultsCollapsedBar.hidden = !collapsed;
    el.toggleResultsBtn.setAttribute("aria-expanded", String(!collapsed));
    el.toggleResultsBtn.textContent = collapsed
      ? `Expandir lista (${state.lastSearchCount})`
      : "Recolher lista";
    if (collapsed && state.currentTrack.title) {
      el.collapsedActiveText.textContent = `Tocando: ${state.currentTrack.artist} — ${state.currentTrack.title}`;
    }
  }

  el.toggleResultsBtn.addEventListener("click", () => setResultsCollapsed(!state.isResultsCollapsed));
  el.expandFromBarBtn.addEventListener("click", () => setResultsCollapsed(false));

  // 1. BUSCA MULTI-EXTENSÃO + LISTAS .M3U
  async function searchMusicWeb(query) {
    el.resultsCollapsedBar.hidden = true;
    el.resultsBody.hidden = false;
    el.toggleResultsBtn.hidden = true;
    showEmptyMessage(
      el.searchResults,
      `Buscando "${query}" em áudio/vídeo (.mp3, .mp4, .flac, .m4a, .ogg, .rma, .rmv, etc.) e em listas .m3u...`
    );
    el.resultsCount.textContent = "Buscando...";

    const results = await searchAllFullTracks(query, el.audio);
    renderSearchResults(results);
  }

  function renderSearchResults(items) {
    el.searchResults.innerHTML = "";
    state.lastSearchCount = items.length;
    el.resultsCount.textContent = `${items.length} faixa(s) completa(s)`;

    if (!items.length) {
      el.toggleResultsBtn.hidden = true;
      el.resultsCollapsedBar.hidden = true;
      showEmptyMessage(
        el.searchResults,
        "Nenhuma faixa completa encontrada nas bases abertas e listas .m3u (amostras < 45s foram rejeitadas). Cole um link direto acima."
      );
      return;
    }

    el.toggleResultsBtn.hidden = false;
    setResultsCollapsed(false);

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const img = document.createElement("img");
      img.src = item.cover100 || DEFAULT_COVER_SVG;
      img.alt = "Capa";
      img.addEventListener("error", () => { img.src = DEFAULT_COVER_SVG; });

      const info = document.createElement("div");
      info.className = "result-info";

      const title = document.createElement("strong");
      title.textContent = item.title;

      const durText = item.durationSec > 0 ? ` • ${formatTime(item.durationSec)}` : "";
      const genreText = item.genre && !isGenericGenre(item.genre) ? ` • ${item.genre}` : "";
      const legacyWarn = item.browserPlayable === false ? " • [Requer M3U/VLC]" : "";
      const meta = document.createElement("span");
      meta.textContent = `${item.artist} • ${item.source}${genreText}${durText}${item.year ? ` (${item.year})` : ""}${legacyWarn}`;

      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "result-actions";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "btn-accent btn-compact";
      playBtn.textContent = "Ouvir";
      playBtn.addEventListener("click", () => {
        el.searchResults.querySelectorAll(".result-item.is-active").forEach((n) => n.classList.remove("is-active"));
        row.classList.add("is-active");

        loadTrack({
          title: item.title,
          artist: item.artist,
          album: item.album,
          url: item.url,
          durationSec: item.durationSec,
          cover: item.cover300 || item.cover100,
          genre: item.genre,
          originalYear: item.year,
          ext: item.ext,
          browserPlayable: item.browserPlayable,
          fromSearch: true
        });

        setResultsCollapsed(true);
      });

      const m3uBtn = document.createElement("button");
      m3uBtn.type = "button";
      m3uBtn.className = "btn-secondary btn-compact";
      m3uBtn.textContent = "+M3U";
      m3uBtn.title = "Adicionar faixa à lista M3U";
      m3uBtn.addEventListener("click", () => {
        addTrackToM3u({
          title: item.title,
          artist: item.artist,
          label: `${item.artist} - ${item.title}`,
          url: item.url,
          duration: item.durationSec > 0 ? item.durationSec : -1,
          genre: item.genre,
          year: item.year
        });
      });

      actions.append(playBtn, m3uBtn);
      row.append(img, info, actions);
      el.searchResults.appendChild(row);
    });
  }

  // 2. PLAYER DE ÁUDIO (SUPORTE A EXPANSÃO DE .M3U COLADO + FORMATOS LEGADOS)
  function switchToNativePlayer() {
    el.embedContainer.hidden = true;
    el.embedContainer.innerHTML = "";
    el.nativeControlsBox.hidden = false;
  }

  function switchToEmbedPlayer(embedInfo) {
    el.audio.pause();
    el.audio.removeAttribute("src");
    el.audio.load();
    visualizer.setPlaying(true);
    el.nativeControlsBox.hidden = true;
    el.embedContainer.hidden = false;
    el.embedContainer.innerHTML = "";

    const iframe = document.createElement("iframe");
    iframe.src = embedInfo.src;
    iframe.height = String(embedInfo.height);
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.loading = "lazy";
    iframe.title = `Player oficial ${embedInfo.provider}`;
    el.embedContainer.appendChild(iframe);
  }

  function rejectCurrentAudio(reason) {
    switchToNativePlayer();
    el.audio.pause();
    el.audio.removeAttribute("src");
    el.audio.load();
    visualizer.setPlaying(false);
    el.playPauseBtn.textContent = "▶";
    el.seekBar.value = 0;
    updateClockDisplays(0, 0);
    state.currentTrack.url = "";
    setPlayerStatus(reason, true);
  }

  async function loadTrack(track, autoPlay = true) {
    if (!track.url) {
      rejectCurrentAudio("Link vazio.");
      return;
    }

    // Se o link colado for uma lista .m3u / .m3u8 direta, tenta extrair a primeira faixa reproduzível
    if (/\.m3u8?(\?|$)/i.test(track.url) && !track.fromSearch) {
      try {
        setPlayerStatus("Lendo lista .M3U...");
        const res = await fetch(track.url);
        if (res.ok) {
          const parsed = parseM3uPlaylistText(await res.text(), track.url, []);
          if (parsed.length) {
            parsed.forEach((p) =>
              addTrackToM3u({
                title: p.title,
                artist: p.artist,
                label: `${p.artist} - ${p.title}`,
                url: p.url,
                duration: p.durationSec,
                genre: "Lista .M3U",
                year: ""
              })
            );
            loadTrack({
              ...track,
              title: parsed[0].title,
              artist: parsed[0].artist,
              url: parsed[0].url,
              durationSec: parsed[0].durationSec
            });
            return;
          }
        }
      } catch {
        // Segue fluxo normal se CORS impedir leitura direta
      }
    }

    const embedInfo = parseOfficialEmbed(track.url);
    if (embedInfo) {
      state.currentTrack = { ...track, isEmbed: true };
      el.trackTitle.textContent = track.title || `Reprodução via ${embedInfo.provider}`;
      el.trackArtist.textContent = track.artist || `Streaming Oficial (${embedInfo.provider})`;
      el.lcdBitrate.textContent = embedInfo.provider.toUpperCase();
      applyTrackCover(track.cover);
      updateTrackBadgeAndMarquee();
      switchToEmbedPlayer(embedInfo);
      setPlayerStatus(
        embedInfo.provider === "YouTube" && window.location.protocol === "file:"
          ? "Player YouTube carregado (se bloquear em file://, abra via servidor local/GitHub Pages)."
          : `Player oficial ${embedInfo.provider} carregado (somente audição, sem download).`
      );

      if (track.title && track.artist && track.artist !== "Link Direto") {
        loadLyricsForTrack(track.artist, track.title);
        loadComposerAndHistory(track.artist, track.title);
      }
      return;
    }

    if (isSampleOrPreviewUrl(track.url, track.title)) {
      rejectCurrentAudio("Link rejeitado: identificado como amostra/prévia. Apenas músicas inteiras são permitidas.");
      return;
    }

    if (isSampleDuration(track.durationSec)) {
      rejectCurrentAudio(`Áudio rejeitado: duração (${track.durationSec}s) inferior a ${MIN_FULL_TRACK_SECONDS}s.`);
      return;
    }

    switchToNativePlayer();
    state.currentTrack = { ...track, isEmbed: false };
    ensureAudioOutputReady();

    el.trackTitle.textContent = track.title || "Faixa sem título";
    el.trackArtist.textContent = `${track.artist || "Artista desconhecido"}${track.album ? ` — ${track.album}` : ""}`;
    el.lcdBitrate.textContent = track.ext ? track.ext.replace(".", "").toUpperCase() : "AUDIO";
    applyTrackCover(track.cover);
    updateTrackBadgeAndMarquee();

    el.directUrlInput.value = track.fromSearch ? "" : track.url;
    el.audio.src = track.url;
    el.audio.load();

    if (track.browserPlayable === false || LEGACY_NON_BROWSER_EXT_REGEX.test(track.url.split("?")[0])) {
      setPlayerStatus(
        `Formato ${track.ext || "legado"} não é decodificado nativamente por navegadores; adicione à lista +M3U para ouvir no VLC/Winamp.`,
        true
      );
    } else {
      setPlayerStatus("Carregando somente áudio da música completa...");
      if (autoPlay) {
        el.audio.play().catch(() => {
          setPlayerStatus("Faixa pronta. Clique em Play (▶) para ouvir.");
        });
      }
    }

    if (track.title && track.artist && track.artist !== "Link Direto") {
      loadLyricsForTrack(track.artist, track.title);
      loadComposerAndHistory(track.artist, track.title);
    } else if (track.title) {
      loadComposerAndHistory("", track.title);
    } else {
      showEmptyMessage(el.historyContent, "Informe o nome da música e artista para pesquisar compositor e história.");
    }
  }

  el.directLinkForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = el.directUrlInput.value.trim();
    if (!url) return;

    const customTitle = el.directTitleInput.value.trim() || url.split("/").pop().split("?")[0] || "Áudio via Link";
    const customArtist = el.directArtistInput.value.trim() || "Link Direto";
    const ext = getFileExtension(url);

    loadTrack({
      title: customTitle,
      artist: customArtist,
      album: "Stream Externo (Somente Áudio)",
      url,
      durationSec: -1,
      cover: "",
      genre: "Streaming por Link",
      originalYear: "",
      ext: ext ? `.${ext}` : "AUDIO",
      browserPlayable: isBrowserPlayableMedia(url, el.audio),
      fromSearch: false
    });
  });

  el.playPauseBtn.addEventListener("click", () => {
    if (!el.audio.src) {
      setPlayerStatus("Busque uma música ou cole um link para ouvir.", true);
      return;
    }
    if (el.audio.paused) {
      ensureAudioOutputReady();
      el.audio.play().catch((err) => setPlayerStatus(`Erro ao reproduzir: ${err.message}`, true));
    } else {
      el.audio.pause();
    }
  });

  el.stopBtn.addEventListener("click", () => {
    if (!el.audio.src) return;
    el.audio.pause();
    el.audio.currentTime = 0;
    el.seekBar.value = 0;
    visualizer.setPlaying(false);
    updateClockDisplays(0, el.audio.duration);
    setPlayerStatus("Reprodução parada.");
  });

  el.audio.addEventListener("play", () => {
    el.playPauseBtn.textContent = "❚❚";
    visualizer.setPlaying(true);
    setPlayerStatus("Ouvindo faixa completa (somente áudio ativo)...");
  });

  el.audio.addEventListener("pause", () => {
    el.playPauseBtn.textContent = "▶";
    visualizer.setPlaying(false);
    if (el.audio.src && !el.playerStatus.classList.contains("status-error")) setPlayerStatus("Pausado.");
  });

  el.audio.addEventListener("ended", () => {
    el.playPauseBtn.textContent = "▶";
    visualizer.setPlaying(false);
  });

  el.audio.addEventListener("loadedmetadata", () => {
    const dur = el.audio.duration;
    if (Number.isFinite(dur) && dur > 0 && dur < MIN_FULL_TRACK_SECONDS) {
      rejectCurrentAudio(`Áudio rejeitado automaticamente: duração real de ${Math.round(dur)}s (amostra/prévia).`);
      return;
    }
    if (el.audio.audioTracks && el.audio.audioTracks.length === 0) {
      rejectCurrentAudio("Este arquivo não possui faixa de áudio reproduzível.");
      return;
    }
    updateClockDisplays(el.audio.currentTime || 0, dur);
    if (Number.isFinite(dur) && dur > 0) state.currentTrack.durationSec = Math.round(dur);
  });

  el.audio.addEventListener("timeupdate", () => {
    if (state.isSeeking || !el.audio.duration || !Number.isFinite(el.audio.duration)) return;
    el.seekBar.value = (el.audio.currentTime / el.audio.duration) * 100;
    updateClockDisplays(el.audio.currentTime, el.audio.duration);
  });

  el.audio.addEventListener("error", () => {
    el.playPauseBtn.textContent = "▶";
    visualizer.setPlaying(false);
    setPlayerStatus("Codec/formato não suportado pelo navegador ou link bloqueado (use +M3U para abrir no VLC/Winamp).", true);
  });

  el.seekBar.addEventListener("input", () => {
    state.isSeeking = true;
    if (el.audio.duration && Number.isFinite(el.audio.duration)) {
      updateClockDisplays((el.seekBar.value / 100) * el.audio.duration, el.audio.duration);
    }
  });

  el.seekBar.addEventListener("change", () => {
    if (el.audio.duration && Number.isFinite(el.audio.duration)) {
      el.audio.currentTime = (el.seekBar.value / 100) * el.audio.duration;
    }
    state.isSeeking = false;
  });

  el.volumeBar.addEventListener("input", () => {
    const vol = Number(el.volumeBar.value);
    el.audio.volume = vol;
    el.audio.muted = vol === 0;
    el.muteBtn.setAttribute("aria-pressed", String(el.audio.muted));
    el.muteBtn.textContent = el.audio.muted ? "Som: Mudo" : "Som: Ligado";
  });

  el.muteBtn.addEventListener("click", () => {
    el.audio.muted = !el.audio.muted;
    if (!el.audio.muted && el.audio.volume === 0) {
      el.audio.volume = 0.8;
      el.volumeBar.value = "0.8";
    }
    el.muteBtn.setAttribute("aria-pressed", String(el.audio.muted));
    el.muteBtn.textContent = el.audio.muted ? "Som: Mudo" : "Som: Ligado";
  });

  el.speedSelect.addEventListener("change", () => {
    el.audio.playbackRate = Number(el.speedSelect.value);
  });

  el.loopBtn.addEventListener("click", () => {
    el.audio.loop = !el.audio.loop;
    el.loopBtn.setAttribute("aria-pressed", String(el.audio.loop));
    el.loopBtn.textContent = `Loop: ${el.audio.loop ? "On" : "Off"}`;
  });

  // 3. LETRA ORIGINAL (SEM SELETOR) + DETECÇÃO AUTOMÁTICA + TRADUÇÃO SEMPRE P/ PT-BR
  function updateGoogleFallbackLink(text) {
    el.googleTranslateFallback.href = `https://translate.google.com/?sl=auto&tl=pt&text=${encodeURIComponent((text || "").slice(0, 1500))}&op=translate`;
  }

  async function loadLyricsForTrack(artist, title) {
    el.lyricsStatus.textContent = "Buscando letra no idioma original...";
    el.detectedLangBadge.textContent = "Idioma: Detectando...";
    el.translationOutput.innerHTML = `<span class="muted">Aguardando tradução para Português (Brasil)...</span>`;

    try {
      const plain = await fetchLyrics(artist, title);
      if (plain) {
        el.lyricsText.value = plain;
        const detected = detectLanguageCode(plain);
        el.detectedLangBadge.textContent = `Idioma: ${languageDisplayName(detected)}`;
        el.lyricsStatus.textContent = `Letra original carregada (${languageDisplayName(detected)}). Clique em 'Traduzir p/ PT-BR'.`;
        updateGoogleFallbackLink(plain);
      } else {
        el.lyricsText.value = "";
        el.detectedLangBadge.textContent = "Idioma: Auto";
        el.lyricsStatus.textContent = "Letra não localizada automaticamente. Cole manualmente para traduzir.";
      }
    } catch (err) {
      el.lyricsStatus.textContent = `Erro ao buscar letra (${err.message}).`;
    }
  }

  async function translateLyricsToPtBr() {
    const raw = el.lyricsText.value.trim();
    if (!raw) {
      el.lyricsStatus.textContent = "Não há letra para traduzir.";
      return;
    }

    updateGoogleFallbackLink(raw);
    const detected = detectLanguageCode(raw);
    el.detectedLangBadge.textContent = `Idioma: ${languageDisplayName(detected)}`;

    el.lyricsStatus.textContent = `Detectado: ${languageDisplayName(detected)} → Traduzindo para Português (Brasil)...`;
    el.translationOutput.textContent = "Traduzindo para Português (Brasil), aguarde...";
    el.translateBtn.disabled = true;

    try {
      const { translated } = await translateTextToPtBr(raw, detected);
      el.translationOutput.textContent = translated;
      el.lyricsStatus.textContent = `Tradução (${languageDisplayName(detected)} → Português - Brasil) concluída!`;
    } catch (err) {
      el.translationOutput.textContent = `Falha na tradução automática (${err.message}). Use o link "Abrir no Google Tradutor ↗" acima.`;
      el.lyricsStatus.textContent = "Falha na API gratuita de tradução.";
    } finally {
      el.translateBtn.disabled = false;
    }
  }

  el.fetchLyricsBtn.addEventListener("click", () => {
    const artist = state.currentTrack.artist || el.directArtistInput.value.trim();
    const title = state.currentTrack.title || el.directTitleInput.value.trim();
    if (!artist || !title) {
      el.lyricsStatus.textContent = "Selecione uma música ou preencha Título e Artista.";
      return;
    }
    loadLyricsForTrack(artist, title);
  });

  el.translateBtn.addEventListener("click", translateLyricsToPtBr);
  el.clearLyricsBtn.addEventListener("click", () => {
    el.lyricsText.value = "";
    el.detectedLangBadge.textContent = "Idioma: Auto";
    el.translationOutput.innerHTML = `<span class="muted">A tradução em Português do Brasil (pt-BR) será exibida nesta área.</span>`;
  });

  // 4. HISTÓRIA ESPECÍFICA DA COMPOSIÇÃO / COMPOSITOR / LETRISTA
  function addCreditLine(parent, label, value) {
    const p = document.createElement("p");
    p.style.margin = "4px 0";
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    p.append(strong, document.createTextNode(value));
    parent.appendChild(p);
  }

  async function loadComposerAndHistory(artist, title) {
    showEmptyMessage(
      el.historyContent,
      "Consultando MusicBrainz, Wikidata e Wikipedia para composição, compositor e letrista..."
    );
    const searchArtist = artist && artist !== "Link Direto" ? artist : "";

    const credits = await fetchComposerAndOriginalMetadata(searchArtist, title);

    if (credits) {
      if (credits.originalYear) state.currentTrack.originalYear = credits.originalYear;
      if (credits.primaryGenre && isGenericGenre(state.currentTrack.genre)) {
        state.currentTrack.genre = credits.primaryGenre;
      }
      if (!state.currentTrack.cover && credits.coverUrl) {
        state.currentTrack.cover = credits.coverUrl;
        applyTrackCover(credits.coverUrl);
      }
    }

    const verifiedCreators = Array.from(
      new Set([
        ...(credits?.composers || []),
        ...(credits?.lyricists || []),
        ...(credits?.writers || [])
      ])
    );
    const validationNames = verifiedCreators.length
      ? [...verifiedCreators, ...(searchArtist ? [searchArtist] : [])]
      : searchArtist
        ? [searchArtist]
        : [];

    const songHistory = await findVerifiedCompositionHistory(title, validationNames);
    const primaryComposerName = verifiedCreators[0] || "";
    const composerBio = primaryComposerName ? await findVerifiedComposerBio(primaryComposerName) : null;

    if (!state.currentTrack.cover && (songHistory?.thumbnail || composerBio?.thumbnail)) {
      const wikiThumb = songHistory?.thumbnail || composerBio?.thumbnail;
      state.currentTrack.cover = wikiThumb;
      applyTrackCover(wikiThumb);
    }
    updateTrackBadgeAndMarquee();

    el.historyContent.innerHTML = "";

    const sec1 = document.createElement("div");
    sec1.className = "history-section";
    const h1 = document.createElement("h4");
    h1.textContent = "Ficha Técnica da Obra Original";
    sec1.appendChild(h1);

    addCreditLine(sec1, "Música / Obra", credits?.workTitle || title);
    if (credits?.performer || searchArtist) addCreditLine(sec1, "Intérprete", credits?.performer || searchArtist);
    if (credits?.composers?.length) addCreditLine(sec1, "Compositor(es)", credits.composers.join(", "));
    if (credits?.lyricists?.length) addCreditLine(sec1, "Letrista(s)", credits.lyricists.join(", "));
    if (credits?.writers?.length) addCreditLine(sec1, "Autor(es) (Música e Letra)", credits.writers.join(", "));
    if (credits?.arrangers?.length) addCreditLine(sec1, "Arranjador(es)", credits.arrangers.join(", "));
    if (!verifiedCreators.length) {
      addCreditLine(
        sec1,
        "Compositor / Letrista",
        "Não há crédito explícito de compositor/letrista registrado nas bases abertas para esta gravação."
      );
    }
    addCreditLine(
      sec1,
      "Ano da gravação original",
      credits?.originalYear || state.currentTrack.originalYear || "Não identificado"
    );
    if (credits?.primaryGenre || state.currentTrack.genre) {
      addCreditLine(sec1, "Gênero musical", credits?.primaryGenre || state.currentTrack.genre);
    }
    el.historyContent.appendChild(sec1);

    const sec2 = document.createElement("div");
    sec2.className = "history-section";
    const h2 = document.createElement("h4");
    h2.textContent = songHistory
      ? `História da Composição (${songHistory.autoTranslated ? `${songHistory.lang.toUpperCase()} → PT-BR` : "PT"})`
      : "História da Composição";
    const p2 = document.createElement("p");

    if (songHistory) {
      p2.textContent = songHistory.extract;
      sec2.append(h2, p2);
      const a = document.createElement("a");
      a.href = songHistory.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "btn-link";
      a.textContent = `Fonte verificada (${songHistory.title}) ↗`;
      sec2.appendChild(a);
    } else if (credits?.workAnnotation) {
      let annText = credits.workAnnotation;
      const annLang = detectLanguageCode(annText);
      if (annLang !== "pt") {
        try {
          annText = (await translateTextToPtBr(annText.slice(0, 1200), annLang)).translated;
        } catch {
          // Mantém original
        }
      }
      p2.textContent = annText;
      sec2.append(h2, p2);
    } else {
      p2.textContent =
        "Nenhum registro histórico específico e verificado sobre a composição desta música foi encontrado (resultados genéricos ou não relacionados foram omitidos).";
      sec2.append(h2, p2);
    }
    el.historyContent.appendChild(sec2);

    if (composerBio) {
      const sec3 = document.createElement("div");
      sec3.className = "history-section";
      const h3 = document.createElement("h4");
      h3.textContent = `Sobre o Compositor / Letrista: ${primaryComposerName} (${composerBio.autoTranslated ? `${composerBio.lang.toUpperCase()} → PT-BR` : "PT"})`;
      const p3 = document.createElement("p");
      p3.textContent = composerBio.extract;
      sec3.append(h3, p3);
      const a2 = document.createElement("a");
      a2.href = composerBio.url;
      a2.target = "_blank";
      a2.rel = "noopener noreferrer";
      a2.className = "btn-link";
      a2.textContent = `Ler mais sobre ${composerBio.title} ↗`;
      sec3.appendChild(a2);
      el.historyContent.appendChild(sec3);
    }
  }

  el.refreshHistoryBtn.addEventListener("click", () => {
    if (!state.currentTrack.title) return;
    loadComposerAndHistory(state.currentTrack.artist, state.currentTrack.title);
  });

  // 5. GERADOR .M3U (GÊNERO + ANO DA GRAVAÇÃO ORIGINAL)
  async function enrichM3uEntryFromOriginals(entry) {
    if (!entry.title || entry.artist === "Link Direto") return;
    if (!isGenericGenre(entry.genre) && entry.year && entry.year !== "N/D") return;

    const credits = await fetchComposerAndOriginalMetadata(entry.artist, entry.title);
    if (!credits) return;

    let changed = false;
    if (isGenericGenre(entry.genre) && credits.primaryGenre) {
      entry.genre = credits.primaryGenre;
      changed = true;
    }
    if ((!entry.year || entry.year === "N/D") && credits.originalYear) {
      entry.year = credits.originalYear;
      changed = true;
    }
    if (changed) renderM3u();
  }

  function addTrackToM3u(entry) {
    if (!entry.url || isSampleOrPreviewUrl(entry.url, entry.label) || isSampleDuration(entry.duration)) {
      setPlayerStatus("Rejeitado na M3U: apenas faixas completas podem ser adicionadas.", true);
      return;
    }

    const cleanGenre = entry.genre && !isGenericGenre(entry.genre) ? entry.genre.trim() : "Não informado";
    const cleanYear = extractYear(entry.year) || "N/D";

    const m3uItem = {
      title: entry.title || "",
      artist: entry.artist || "",
      label: entry.label || "Faixa sem nome",
      url: entry.url,
      duration: Number.isFinite(entry.duration) ? entry.duration : -1,
      genre: cleanGenre,
      year: cleanYear
    };

    state.m3uTracks.push(m3uItem);
    renderM3u();

    if (m3uItem.genre === "Não informado" || m3uItem.year === "N/D") {
      enrichM3uEntryFromOriginals(m3uItem);
    }
  }

  function buildM3uString() {
    const lines = ["#EXTM3U"];
    for (const item of state.m3uTracks) {
      const genre = item.genre || "Não informado";
      const year = item.year || "N/D";
      lines.push(`#EXTGENRE:${genre}`);
      lines.push(`#EXTYEAR:${year}`);
      lines.push(`#EXTINF:${item.duration},${item.label} [Gênero: ${genre} | Ano: ${year}]`);
      lines.push(item.url);
    }
    return lines.join("\n");
  }

  function renderM3u() {
    el.m3uList.innerHTML = "";
    state.m3uTracks.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = "m3u-item";

      const span = document.createElement("span");
      span.textContent = `${index + 1}. ${item.label} • ${item.genre} • ${item.year}`;

      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "m3u-remove";
      rmBtn.textContent = "Remover";
      rmBtn.addEventListener("click", () => {
        state.m3uTracks.splice(index, 1);
        renderM3u();
      });

      li.append(span, rmBtn);
      el.m3uList.appendChild(li);
    });

    el.m3uPreview.value = buildM3uString();
  }

  el.addCurrentToM3uBtn.addEventListener("click", () => {
    if (!state.currentTrack.url) {
      setPlayerStatus("Nenhuma faixa carregada para adicionar à M3U.", true);
      return;
    }
    addTrackToM3u({
      title: state.currentTrack.title,
      artist: state.currentTrack.artist,
      label: `${state.currentTrack.artist} - ${state.currentTrack.title}`,
      url: state.currentTrack.url,
      duration: state.currentTrack.durationSec > 0 ? state.currentTrack.durationSec : -1,
      genre: state.currentTrack.genre,
      year: state.currentTrack.originalYear
    });
  });

  el.m3uAddCustomBtn.addEventListener("click", () => {
    const url = el.m3uCustomUrl.value.trim();
    const label = el.m3uCustomTitle.value.trim() || "Faixa Completa";
    const genre = el.m3uCustomGenre.value.trim() || "Não informado";
    const year = extractYear(el.m3uCustomYear.value) || "N/D";
    if (!url) return;

    const parts = label.split(/\s+-\s+/);
    addTrackToM3u({
      title: parts.length > 1 ? parts.slice(1).join(" - ").trim() : label,
      artist: parts.length > 1 ? parts[0].trim() : "",
      label,
      url,
      duration: -1,
      genre,
      year
    });

    el.m3uCustomTitle.value = "";
    el.m3uCustomGenre.value = "";
    el.m3uCustomYear.value = "";
    el.m3uCustomUrl.value = "";
  });

  el.clearM3uBtn.addEventListener("click", () => {
    state.m3uTracks = [];
    renderM3u();
  });

  el.copyM3uBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildM3uString());
      el.copyM3uBtn.textContent = "Copiado!";
      setTimeout(() => (el.copyM3uBtn.textContent = "Copiar"), 1500);
    } catch {
      el.m3uPreview.select();
      document.execCommand("copy");
    }
  });

  el.downloadM3uBtn.addEventListener("click", () => {
    const blob = new Blob([buildM3uString()], { type: "audio/x-mpegurl;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "playlist.m3u";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  el.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = el.searchInput.value.trim();
    if (q) searchMusicWeb(q);
  });

  renderM3u();
})();