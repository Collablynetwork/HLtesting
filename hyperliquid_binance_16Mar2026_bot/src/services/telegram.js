import axios from 'axios';
import { CONFIG } from '../config.js';

export async function sendTelegram(text, replyToMessageId = null) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    return null;
  }

  const payload = {
    chat_id: CONFIG.telegram.chatId,
    text,
    disable_web_page_preview: true
  };

  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  const { data } = await axios.post(
    `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
    payload,
    { timeout: 15000 }
  );

  return data?.result?.message_id || null;
}
