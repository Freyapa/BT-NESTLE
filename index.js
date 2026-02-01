'use strict';

process.env.PYTHONWARNINGS = 'ignore';
process.env.PYTHONUNBUFFERED = '1';

require('dotenv').config({ path: './config/.env' });
const path = require('path');
const { Client, GatewayIntentBits, Routes, REST, SlashCommandBuilder, MessageFlags, EmbedBuilder, Events } = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const fs = require('fs');
const play = require('play-dl');

// --- SECURITY UPGRADE: Dependencies ---
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

// --- SECURITY UPGRADE: Firebase Admin Setup ---
let db;
try {
  let serviceAccount;
  if (process.env.FIREBASE_CREDENTIALS) {
    // Production / Railway: Load from Environment Variable
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    console.log("Status: Loaded Firebase Credentials from Environment Variable");
  } else {
    // Local Development: Load from File
    serviceAccount = require('./config/serviceAccountKey.json');
    console.log("Status: Loaded Firebase Credentials from Local File");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://discordunknow-54ce9-default-rtdb.asia-southeast1.firebasedatabase.app/"
  });
  db = admin.database();
  console.log("Status: Firebase Admin SDK Initialized (Secure Mode)");
} catch (error) {
  console.error("CRITICAL: Failed to load Firebase Credentials. Error details:", error.message);
  db = {
    isMock: true,
    ref: () => ({
      set: () => Promise.resolve(),
      get: () => Promise.resolve({ exists: () => false, val: () => null }),
      once: () => Promise.resolve({ exists: () => false, val: () => null }),
      push: () => Promise.resolve({ key: "mock_key" }),
      remove: () => Promise.resolve()
    })
  };
}

// --- CONFIG ---
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_TO_A_SUPER_SECRET_KEY_IN_ENV';
const PORT = process.env.PORT || 8080;

let youtubeCookie = undefined;
try {
  const txtPath = path.join(__dirname, 'config', 'cookies.txt');
  if (fs.existsSync(txtPath)) {
    youtubeCookie = txtPath;
  }
} catch (e) { }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const plugins = [
  new SpotifyPlugin(),
  new YtDlpPlugin({ update: false, cookie: youtubeCookie })
];

const distube = new DisTube(client, {
  emitNewSongOnly: true,
  emitAddSongWhenCreatingQueue: false,
  emitAddListWhenCreatingQueue: false,
  plugins,
  customFilters: {
    '8d': 'apulsator=hz=0.125'
  },
  ffmpeg: {
    args: {
      global: { 'reconnect': '1', 'reconnect_streamed': '1', 'reconnect_delay_max': '5' },
      input: { 'reconnect': '1' }
    },
  },
});

// --- DISTUBE EVENTS (Thai & Rich Embeds) ---
distube
  .on('playSong', (queue, song) => {
    // Show Thumbnail and Title
    const embed = new EmbedBuilder()
      .setColor(0x1db954) // Green
      .setTitle('กำลังเล่นเพลง')
      .setDescription(`ชื่อเพลง: ${song.name}`)
      .setImage(song.thumbnail)
      .setFooter({ text: `ขอมาโดย: ${song.user.username}` });

    queue.textChannel?.send({ embeds: [embed] }).catch(() => { });
  })
  .on('addSong', (queue, song) => {
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('เพิ่มเพลงลงคิวแล้ว')
      .setDescription(`ชื่อเพลง: ${song.name}`)
      .setThumbnail(song.thumbnail);

    queue.textChannel?.send({ embeds: [embed] }).catch(() => { });
  })
  .on('finish', (queue) => {
    queue.textChannel?.send('หมดคิวเพลงแล้ว บอทกำลังจะออกจากห้อง').catch(() => { });
    setTimeout(() => { try { distube.voices.leave(queue.id); } catch (e) { } }, 2000);
  })
  .on('error', (error, queue) => {
    if (queue?.textChannel) queue.textChannel.send(`เกิดข้อผิดพลาด: ${error.toString().slice(0, 100)}`).catch(() => { });
    console.error('DisTube Error:', error);
  });

// --- COMMANDS ---
const commands = [
  new SlashCommandBuilder().setName('nestle').setDescription('เล่นเพลง').addStringOption(o => o.setName('query').setDescription('ชื่อเพลง หรือ ลิงก์').setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('ออกจากห้องเสียง'),
  new SlashCommandBuilder().setName('skip').setDescription('ข้ามเพลง'),
  new SlashCommandBuilder().setName('site').setDescription('รับลิงก์จัดการเพลย์ลิสต์'),
  new SlashCommandBuilder().setName('playlish').setDescription('เล่นเพลงจากเพลย์ลิสต์ส่วนตัว'),
  new SlashCommandBuilder().setName('deletechat').setDescription('ลบข้อความบอท'),
  new SlashCommandBuilder().setName('8d').setDescription('เปิด/ปิด โหมดเสียง 8D'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || process.env.DISCORD_TOKEN);

async function registerCommands(clientId) {
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Reloaded commands (Thai).');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands(client.user.id);
});

// --- TEXT COMMAND HANDLER ("nestle ...") ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;

  // Check prefix
  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('nestle')) return;

  // Parse args: "nestle เล่นเพลง https://..." -> ["nestle", "เล่นเพลง", "https://..."]
  const args = content.split(/\s+/);
  if (args.length < 2) return; // Just "nestle" -> ignore

  const command = args[1].toLowerCase(); // "เล่นเพลง", "ข้ามเพลง", etc.
  const query = args.slice(2).join(' '); // Remainder

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('คุณต้องอยู่ในห้องเสียงก่อนใช้งานคำสั่ง');
  }

  // --- Logic Map ---

  // 1. Play (เล่นเพลง)
  if (command === 'เล่นเพลง' || command === 'เล่น') {
    if (!query) return message.reply('กรุณาระบุชื่อเพลง หรือ ลิงก์ที่ต้องการเล่น');

    // Feedback
    const loadingMsg = await message.reply('กำลังค้นหาเพลง...');

    try {
      // DisTube Play
      await distube.play(voiceChannel, query, {
        member: message.member,
        textChannel: message.channel,
        message: message
      });
      // The 'playSong' or 'addSong' event will handle the success message/embed
      // We can delete the loading msg
      setTimeout(() => loadingMsg.delete().catch(() => { }), 2000);

    } catch (e) {
      loadingMsg.edit(`เกิดข้อผิดพลาด: ${e.message}`);
    }
  }

  // 2. Skip (ข้ามเพลง)
  else if (command === 'ข้ามเพลง' || command === 'ข้าม') {
    try {
      await distube.skip(message.guild.id);
      message.reply('ข้ามเพลงแล้ว');
    } catch (e) { message.reply('ไม่มีเพลงให้ข้าม หรือ คิวหมดแล้ว'); }
  }

  // 3. Leave (ออก)
  else if (command === 'ออก' || command === 'leave') {
    try {
      distube.voices.leave(message.guild.id);
      message.reply('ออกจากห้องแล้ว');
    } catch (e) { message.reply('ไม่ได้อยู่ในห้องเสียง'); }
  }

  // 4. 8D (8d)
  else if (command === '8d') {
    try {
      const queue = distube.getQueue(message.guild.id);
      if (!queue) return message.reply('ตอนนี้ยังไม่มีเพลงกำลังเล่นอยู่');

      if (queue.filters.has('8d')) {
        queue.filters.remove('8d');
        message.reply('ปิดโหมด 8D แล้ว (เสียงปกติ)');
      } else {
        queue.filters.add('8d');
        message.reply('เปิดโหมด 8D แล้ว');
      }
    } catch (e) { message.reply('เกิดข้อผิดพลาดในการปรับโหมดเสียง'); }
  }

  // 5. Site / Playlist (เว็บไซต์เพลย์ลิส)
  else if (command === 'เว็บไซต์เพลย์ลิส' || command === 'เว็บ') {
    const userId = message.author.id;
    const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '1h' });
    const link = `https://nestlesystem115.vercel.app/?token=${token}`;

    message.reply(`**ลิงก์จัดการเพลย์ลิสต์ส่วนตัว**\n${link}\n*ลิงก์มีอายุ 1 ชั่วโมง*`);
  }

  // 6. Playlish (เล่นเพลย์ลิสต์)
  else if (command === 'nestle playlist' || command === 'เพลย์ลิสต์') {
    if (!voiceChannel) return message.reply('ต้องเข้าห้องเสียงก่อนครับ');
    const msg = await message.reply('กำลังโหลดเพลย์ลิสต์...');
    try {
      const snapshot = await db.ref(`playlists/${message.author.id}`).once('value');
      if (!snapshot.exists()) {
        return msg.edit('เพลย์ลิสต์ของคุณว่างเปล่า เพิ่มเพลงผ่านเว็บก่อนนะครับ');
      }

      const songs = Object.values(snapshot.val()).map(i => i.url);
      const playlist = await distube.createCustomPlaylist(songs, {
        member: message.member,
        properties: { name: `${message.author.username}'s Playlist` },
        parallel: true
      });

      await distube.play(voiceChannel, playlist, {
        member: message.member,
        textChannel: message.channel,
        message: message
      });
      msg.delete();
    } catch (e) {
      msg.edit(`เกิดข้อผิดพลาด: ${e.message}`);
    }
  }

  // 7. Delete Chat (ลบแชท)
  else if (command === 'deletechat' || command === 'ลบแชท') {
    if (message.channel) {
      try {
        await message.channel.bulkDelete(100, true);
        const reply = await message.reply('ลบข้อความเรียบร้อยแล้ว');
        setTimeout(() => reply.delete(), 3000);
      } catch (e) {
        message.reply('ไม่สามารถลบข้อความได้ (อาจเป็นเพราะข้อความเก่าเกินไป)');
      }
    }
  }

});

// --- SLASH COMMAND HANDLER (Legacy Support / Hybrid) ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const voiceChannel = interaction.member.voice.channel;

  if (commandName === 'nestle') {
    if (!voiceChannel) return interaction.reply({ content: 'คุณต้องอยู่ในห้องเสียง', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();

    let query = interaction.options.getString('query');
    await interaction.editReply('กำลังค้นหาเพลง...');

    try {
      if (!query.startsWith('http')) {
        const res = await play.search(query, { limit: 1 });
        if (res.length > 0) query = res[0].url;
      }
      await distube.play(voiceChannel, query, { member: interaction.member, textChannel: interaction.channel });
      await interaction.deleteReply(); // Ensure only the Embed event shows up to avoid duplicates? Or edit to "Done".
      // Actually distube emits events, so let's just let events handle it. 
      // But we need to close the defer.
    } catch (e) {
      interaction.editReply(`ไม่สามารถเล่นได้: ${e.message}`);
    }
  }

  else if (commandName === '8d') {
    const queue = distube.getQueue(interaction.guildId);
    if (!queue) return interaction.reply('ไม่มีเพลงเล่นอยู่');
    if (queue.filters.has('8d')) {
      queue.filters.remove('8d');
      interaction.reply('ปิดโหมด 8D');
    } else {
      queue.filters.add('8d');
      interaction.reply('เปิดโหมด 8D');
    }
  }

  else if (commandName === 'site') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '1h' });
    const link = `https://nestlesystem115.vercel.app/?token=${token}`;
    interaction.editReply({ content: `ลิงก์จัดการเพลย์ลิสต์: ${link}` });
  }

  else if (commandName === 'deletechat') {
    if (interaction.channel) {
      try {
        await interaction.channel.bulkDelete(100, true);
        interaction.reply({ content: 'ลบข้อความ 100 ข้อความล่าสุดเรียบร้อยแล้ว', flags: MessageFlags.Ephemeral });
      } catch (e) {
        interaction.reply({ content: 'ไม่สามารถลบข้อความได้ (อาจเป็นเพราะข้อความเก่าเกินไป)', flags: MessageFlags.Ephemeral });
      }
    } else {
      interaction.reply({ content: 'ไม่สามารถทำรายการได้ในขณะนี้', flags: MessageFlags.Ephemeral });
    }
  }

  else if (commandName === 'leave') {
    try {
      const voice = distube.voices.get(interaction.guildId);
      if (voice) {
        distube.voices.leave(interaction.guildId);
        interaction.reply({ content: 'ออกจากห้องแล้ว', flags: MessageFlags.Ephemeral });
      } else {
        interaction.reply({ content: 'ไม่ได้อยู่ในห้องเสียง', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      interaction.reply({ content: 'เกิดข้อผิดพลาดในการออก', flags: MessageFlags.Ephemeral });
    }
  }

  else if (commandName === 'skip') {
    try { await distube.skip(interaction.guildId); } catch (e) { interaction.reply('ข้ามไม่ได้'); }
  }

  else if (commandName === 'playlish') {
    if (db.isMock) {
      return interaction.reply({
        content: '⚠️ **ระบบยังไม่ได้เชื่อมต่อฐานข้อมูล** (Missing serviceAccountKey.json)\nบอทจึงไม่เห็นเพลงที่คุณเพิ่มในเว็บ กรุณาดู Log เพื่อหาสาเหตุครับ',
        flags: MessageFlags.Ephemeral
      });
    }

    if (!voiceChannel) return interaction.reply({ content: 'คุณต้องอยู่ในห้องเสียง', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();

    try {
      const snapshot = await db.ref(`playlists/${interaction.user.id}`).once('value');
      if (!snapshot.exists()) {
        return interaction.editReply('เพลย์ลิสต์ของคุณว่างเปล่า เพิ่มเพลงผ่านเว็บก่อนนะครับ');
      }

      // 1. Sort by addedAt
      const data = snapshot.val();
      const items = Object.values(data).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      const songs = items.map(i => i.url);

      // 2. Create Table
      let table = "```md\n| ลำดับ | ชื่อเพลง |\n|---|---|\n";
      items.forEach((item, index) => {
        const title = (item.title || "Unknown Title").substring(0, 30); // Truncate
        table += `| ${index + 1} | ${title} |\n`;
      });
      table += "```";

      interaction.channel.send(`**เพลย์ลิสต์ของ ${interaction.user.username}**\n${table}`);

      const playlist = await distube.createCustomPlaylist(songs, {
        member: interaction.member,
        properties: { name: `${interaction.user.username}'s Playlist` },
        parallel: true
      });

      await distube.play(voiceChannel, playlist, {
        member: interaction.member,
        textChannel: interaction.channel
      });
      await interaction.deleteReply();
    } catch (e) {
      interaction.editReply(`เกิดข้อผิดพลาด: ${e.message}`);
    }
  }

});


// --- STATS & API ---
client.on(Events.ClientReady, () => {
  setInterval(() => {
    try {
      if (db && db.ref) {
        db.ref('stats/bot_status').set({
          ping: client.ws.ping,
          uptime: process.uptime(),
          servers: client.guilds.cache.size,
          users: client.users.cache.size,
          last_updated: Date.now()
        });
      }
    } catch (e) { }
  }, 5000);
});

client.login(process.env.TOKEN || process.env.DISCORD_TOKEN);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.json());

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "No token" });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid Token" });
    req.user = decoded;
    next();
  });
};

app.get('/', (req, res) => res.send('API Active'));

app.get('/api/playlist', verifyToken, async (req, res) => {
  try {
    const s = await db.ref(`playlists/${req.user.uid}`).once('value');
    res.json(s.val() || {});
  } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.post('/api/playlist', verifyToken, async (req, res) => {
  try {
    const { url, title } = req.body;
    await db.ref(`playlists/${req.user.uid}`).push({
      url, title: title || url, addedAt: admin.database.ServerValue.TIMESTAMP
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.delete('/api/playlist/:key', verifyToken, async (req, res) => {
  try {
    await db.ref(`playlists/${req.user.uid}/${req.params.key}`).remove();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.listen(PORT, () => console.log(`API running on ${PORT}`));
