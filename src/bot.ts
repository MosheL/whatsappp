import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function transcribeBuffer(buffer: Buffer): Promise<string> {
  try {
    const base64Data = buffer.toString('base64');
    const payload = {
      type: "blob",
      data: base64Data,
      model: "ivrit-ai/whisper-large-v3-turbo-ct2"
    };

    const response = await axios.post(
      'http://10.0.7.10:8000/transcribe',
      payload,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.text || '';
  } catch (err: any) {
    console.error('❌ שגיאה בתמלול:', err.message);
    return '';
  }
}

export async function createBot(authFolder: string, label: string) {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const wrapper = {
    sock: undefined as ReturnType<typeof makeWASocket> | undefined,
    id: '',
    async sendText(jid: string, text: string) {
      if (!wrapper.sock) throw new Error('Socket not connected');
      await wrapper.sock.sendMessage(jid, { text });
    }
  };

  async function startSock() {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      shouldIgnoreJid: jid => jid === 'status@broadcast'
    });

    wrapper.sock = sock;
    wrapper.id = sock.user?.id || '';

    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.log(`${label} 📱 סרוק את הקוד הבא:`);
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log(`${label} ✅ התחברת בהצלחה ל־WhatsApp`);
      }
      if (connection === 'close') {
        console.log(`${label} ❌ החיבור נסגר:`, lastDisconnect?.error);
        setTimeout(startSock, 5000); // התחברות מחדש
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const messageType = Object.keys(msg.message)[0];

      const remoteJid = msg.key.remoteJid!;
       if (remoteJid.endsWith('@g.us')) {
            const groupMeta = await sock.groupMetadata(remoteJid);
            const me = groupMeta.participants.find(p => p.id === sock.user?.lid!.split(":")[0]+"@lid");

            if (!me) return console.log(`${label} 🚫 איני חבר בקבוצה ${remoteJid}`);
            if (groupMeta.announce && me.admin !== 'admin') {
              return console.log(`${label} 🔒 ${groupMeta.subject} נעולה לאדמינים`);
            }
          }

      if (messageType === 'audioMessage') {
        console.log(`${label} 📥 קולית נכנסה!`);

        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger! });
          const transcript = await transcribeBuffer(buffer);
          console.log(`${label} 📝 תמלול:`, transcript);

          if (transcript) {
            await sock.sendMessage(remoteJid, {
              text: `📝 תמלול:\n${transcript}`,
            },{ quoted: msg});
          }
        } catch (err: any) {
          console.error(`${label} ❌ שגיאה:`, err.message);
        }
      }
    });
  }

  await startSock();
  return wrapper;
}
