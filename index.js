import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');

const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com or Vercel domain
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL missing in .env');

const RAPIDAPI_KEYS = (process.env.RAPIDAPI_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

if (!RAPIDAPI_KEYS.length) throw new Error('RAPIDAPI_KEYS missing or empty in .env');

let keyIndex = 0;
function getNextKey() {
  const key = RAPIDAPI_KEYS[keyIndex % RAPIDAPI_KEYS.length];
  keyIndex++;
  return key;
}

const API_PROVIDERS = [
  {
    name: 'RapidAPI-1',
    url: 'https://tiktok-video-no-watermark2.p.rapidapi.com/',
    buildHeaders: () => ({
      'x-rapidapi-key': getNextKey(),
      'x-rapidapi-host': 'tiktok-video-no-watermark2.p.rapidapi.com',
    }),
    extract: (data) => {
      const play = data?.data?.play;
      if (!play) return null;
      return {
        videoUrl: play,
        title: data?.data?.title || 'TikTok Video',
        author: data?.data?.author?.nickname || 'Unknown',
      };
    },
    method: 'GET',
    paramKey: 'url',
    timeout: 15000,
  },
  {
    name: 'RapidAPI-2',
    url: 'https://tiktok-video-no-watermark.p.rapidapi.com/',
    buildHeaders: () => ({
      'x-rapidapi-key': getNextKey(),
      'x-rapidapi-host': 'tiktok-video-no-watermark.p.rapidapi.com',
    }),
    extract: (data) => {
      const play = data?.data?.play || data?.data?.wmplay || data?.play;
      if (!play) return null;
      return {
        videoUrl: play,
        title: data?.data?.title || data?.title || 'TikTok Video',
        author: data?.data?.author?.nickname || data?.author || 'Unknown',
      };
    },
    method: 'GET',
    paramKey: 'url',
    timeout: 15000,
  },
];

const TIKTOK_REGEX = /https?:\/\/(www\.)?(m\.)?(vm\.)?tiktok\.com\/[^\s]+/i;
const ALLOWED_DOMAINS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com'];

function isTikTokUrl(text) {
  if (!TIKTOK_REGEX.test(text)) return false;
  try {
    const match = text.match(TIKTOK_REGEX);
    if (!match) return false;
    const url = new URL(match[0]);
    return ALLOWED_DOMAINS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function simulatedProgress(bot, chatId, messageId) {
  const frames = [
    '⏳ Fetching your video… ░░░░',
    '⏳ Fetching your video… ▓░░░',
    '⏳ Fetching your video… ▓▓░░',
    '⏳ Fetching your video… ▓▓▓░',
    '⏳ Fetching your video… ▓▓▓▓',
  ];
  for (let i = 0; i < frames.length; i++) {
    await bot.telegram.editMessageText(chatId, messageId, undefined, `*${frames[i]}*`, {
      parse_mode: 'Markdown',
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function fetchViaProviders(videoUrl) {
  for (const provider of API_PROVIDERS) {
    try {
      const headers = provider.buildHeaders();
      const req = {
        method: provider.method || 'GET',
        url: provider.url,
        params: { [provider.paramKey || 'url']: videoUrl },
        headers,
        timeout: provider.timeout || 15000,
      };

      const res = await axios.request(req);
      const normalized = provider.extract(res.data);
      if (normalized?.videoUrl) {
        return { ok: true, provider: provider.name, ...normalized };
      }
    } catch (e) {
      // try next provider
    }
  }
  return { ok: false };
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔗 Share Bot', 'https://t.me/share/url?url=TikTok%20Downloader%20Bot')],
    [Markup.button.callback('↩️ Try Another', 'TRY_ANOTHER')],
  ]);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    [
      '👋 *Welcome!*',
      'Send me a TikTok link, and I will fetch the video (no watermark if available).',
      '',
      '⚠️ Please use responsibly. Respect TikTok & RapidAPI TOS.',
    ].join('\n'),
    { parse_mode: 'Markdown', ...mainKeyboard() }
  )
);

bot.action('TRY_ANOTHER', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🔁 Send another TikTok link:', mainKeyboard());
});

bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  if (!isTikTokUrl(text)) {
    return ctx.reply('⚠️ Please send a valid *tiktok.com* link.', { parse_mode: 'Markdown' });
  }

  const loading = await ctx.reply('⏳ *Fetching your video…*', { parse_mode: 'Markdown' });
  try {
    await simulatedProgress(bot, ctx.chat.id, loading.message_id);

    const result = await fetchViaProviders(text);
    if (!result.ok) {
      await bot.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, '❌ All providers failed.');
      return;
    }

    await bot.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, '✅ Sending your video…');

    const caption = [
      `🎬 *${result.title}*`,
      `👤 Author: ${result.author}`,
      `🛰 Provider: ${result.provider}`,
    ].join('\n');

    await ctx.replyWithVideo(
      { url: result.videoUrl },
      {
        caption,
        parse_mode: 'Markdown',
        supports_streaming: true,
        ...mainKeyboard(),
      }
    );
  } catch (err) {
    await bot.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, '❌ Error. Try again.');
  }
});

// ---------------- Express Server ----------------
const app = express();
app.use(express.json());

// Set webhook
app.use(bot.webhookCallback(`/webhook`));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
  console.log(`✅ Webhook set to ${WEBHOOK_URL}/webhook`);
});
