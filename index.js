'use strict';

process.env.PYTHONWARNINGS = 'ignore';
process.env.PYTHONUNBUFFERED = '1';

require('dotenv').config({ path: './config/.env' });
const path = require('path');
const { Client, GatewayIntentBits, Routes, REST, SlashCommandBuilder, MessageFlags, ActivityType, Events } = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { getVoiceConnection } = require('@discordjs/voice');
const fs = require('fs');
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get, child, set } = require("firebase/database");
const play = require('play-dl');

const firebaseConfig = {
  apiKey: "AIzaSyBY5b_eChwHx3qO-J4YkW9aw03xOOEMurM",
  authDomain: "discordunknow-54ce9.firebaseapp.com",
  projectId: "discordunknow-54ce9",
  storageBucket: "discordunknow-54ce9.firebasestorage.app",
  messagingSenderId: "571989738366",
  appId: "1:571989738366:web:009545030d8cbcfc11292f",
  measurementId: "G-25J7QG5SM5",
  databaseURL: "https://discordunknow-54ce9-default-rtdb.asia-southeast1.firebasedatabase.app/"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

let youtubeCookie = undefined;
try {
  const jsonPath = path.join(__dirname, 'config', 'cookies.json');
  const txtPath = path.join(__dirname, 'config', 'cookies.txt');

  if (fs.existsSync(txtPath)) {
    youtubeCookie = txtPath;
    console.log('Cookies loaded from config/cookies.txt');
  } else if (fs.existsSync(jsonPath)) {
    youtubeCookie = jsonPath;
    console.log('Cookies loaded from config/cookies.json');
  } else {
    console.log('No cookies found.');
  }
} catch (e) {
  console.warn('Error checking cookies:', e);
}

try {
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
    console.log('Using System FFmpeg');
  } else {
    const ff = require('ffmpeg-static');
    if (ff) {
      process.env.FFMPEG_PATH = ff;
      process.env.PATH = `${process.env.PATH}${path.delimiter}${path.dirname(ff)}`;
      console.log('Using ffmpeg-static');
    }
  }
} catch (e) {
  console.warn('FFmpeg setup warning:', e);
}

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
  new YtDlpPlugin({
    update: false,
    cookie: youtubeCookie
  })
];

const distube = new DisTube(client, {
  emitNewSongOnly: true,
  emitAddSongWhenCreatingQueue: false,
  emitAddListWhenCreatingQueue: false,
  plugins,
  ffmpeg: {
    args: {
      global: {
        'reconnect': '1',
        'reconnect_streamed': '1',
        'reconnect_delay_max': '5',
      },
      input: {
        'reconnect': '1',
      }
    },
  },
});

distube
  .on('playSong', (queue, song) => {
    const msg = `Playing: ${song.name}`;
    queue.textChannel?.send(msg).catch(() => { });
  })
  .on('finish', (queue) => {
    setTimeout(() => {
      try {
        distube.voices.leave(queue.id);
      } catch (e) { }
    }, 2000);
  })
  .on('addSong', (queue, song) => {
    const msg = `Added: ${song.name}`;
    queue.textChannel?.send(msg).catch(() => { });
  })
  .on('error', (error, queue) => {
    if (queue && queue.textChannel) {
      queue.textChannel.send(`Error: ${error.toString().slice(0, 1900)}`).catch(() => { });
    }
    console.error('DisTube Error:', error);
  });

const commands = [
  new SlashCommandBuilder()
    .setName('nestle')
    .setDescription('Play a song')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name or link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip current song'),
  new SlashCommandBuilder()
    .setName('site')
    .setDescription('Get playlist management link'),
  new SlashCommandBuilder()
    .setName('playlish')
    .setDescription('Play songs from your web playlist'),
  new SlashCommandBuilder()
    .setName('deletechat')
    .setDescription('Delete bot messages'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || process.env.DISCORD_TOKEN);

async function registerCommands(clientId) {
  try {
    console.log('Refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands(client.user.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inCachedGuild()) {
    return interaction.reply({ content: 'Command cannot be used in DMs.', flags: MessageFlags.Ephemeral });
  }

  const { commandName } = interaction;
  const voiceChannel = interaction.member.voice.channel;

  if (commandName === 'nestle') {
    try {
      await interaction.deferReply();
    } catch (err) {
      if ([10062, 10015].includes(err.code)) return;
      return;
    }

    if (!voiceChannel) {
      return interaction.editReply('You must be in a voice channel.');
    }

    let query = interaction.options.getString('query');
    let statusMsg = 'Searching...';
    await interaction.editReply(statusMsg);

    if (!query.startsWith('http')) {
      try {
        if (youtubeCookie) {
          try {
            if (fs.existsSync(youtubeCookie) && youtubeCookie.endsWith('.json')) {
              const cookieData = JSON.parse(fs.readFileSync(youtubeCookie, 'utf-8'));
              await play.setToken({ youtube: { cookie: cookieData } });
            }
          } catch (e) { }
        }

        const searchResults = await play.search(query, { limit: 1 });
        if (searchResults && searchResults.length > 0) {
          query = searchResults[0].url;
          statusMsg = `Found: ${searchResults[0].title}`;
          await interaction.editReply(statusMsg);
        } else {
          throw new Error("No results found.");
        }
      } catch (searchErr) {
        return interaction.editReply(`Search failed: ${searchErr.message}`);
      }
    }

    try {
      await interaction.editReply(`${statusMsg}\nConnecting...`);

      await distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel
      });

      await interaction.editReply(`${statusMsg}\nPlaying.`);
    } catch (error) {
      if (error.errorCode === 'VOICE_MISSING_PERMS') {
        return interaction.editReply('Permission denied. Cannot join voice channel.');
      }
      return interaction.editReply(`Error: ${error.toString().slice(0, 100)}`);
    }
  }
  else if (commandName === 'leave') {
    try {
      try { await interaction.deferReply(); } catch (e) { return; }
      distube.voices.leave(interaction.guildId);

      setTimeout(() => {
        const connection = getVoiceConnection(interaction.guildId);
        if (connection) connection.destroy();
      }, 1000);

      await interaction.deleteReply().catch(() => { });
    } catch (e) { }
  }
  else if (commandName === 'skip') {
    try {
      try { await interaction.deferReply(); } catch (e) { return; }
      const queue = distube.getQueue(interaction.guildId);
      if (!queue) {
        return interaction.editReply('Queue is empty.').catch(() => { });
      }
      try {
        await distube.skip(interaction.guildId);
        await interaction.editReply('Skipped.');
      } catch (e) {
        await interaction.editReply('No more songs to skip.');
      }
    } catch (e) { }
  }
  else if (commandName === 'site') {
    const userId = interaction.user.id;
    await interaction.reply({
      content: `**Playlist Management**\n[Click Here](https://discordunknow-g4zs.vercel.app/?uid=${userId})`,
      flags: MessageFlags.Ephemeral
    });
  }
  else if (commandName === 'playlish') {
    await interaction.deferReply();

    if (!voiceChannel) {
      return interaction.editReply('You must be in a voice channel.');
    }

    try {
      const userId = interaction.user.id;
      const dbRef = ref(db);
      const snapshot = await get(child(dbRef, `playlists/${userId}`));

      if (!snapshot.exists()) {
        return interaction.editReply('Playlist is empty.');
      }

      const data = snapshot.val();
      const playlist = Array.isArray(data) ? data : Object.values(data);
      const validSongs = playlist.filter(url => url && typeof url === 'string');

      if (validSongs.length === 0) {
        return interaction.editReply('Playlist is empty.');
      }

      await interaction.editReply(`Loading ${validSongs.length} songs...`);

      for (const url of validSongs) {
        try {
          await distube.play(voiceChannel, url, {
            member: interaction.member,
            textChannel: interaction.channel,
            skip: false
          });
        } catch (err) { }
      }

      await interaction.followUp('Playlist added to queue.');

    } catch (e) {
      await interaction.editReply('Failed to load playlist.');
    }
  }
  else if (commandName === 'deletechat') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      const botMessages = messages.filter(msg => msg.author.id === client.user.id);

      if (botMessages.size > 0) {
        try {
          await interaction.channel.bulkDelete(botMessages, true);
          await interaction.editReply(`Deleted **${botMessages.size}** messages.`);
        } catch (err) {
          if (err.code === 50013) {
            await interaction.editReply('Deleting messages manually...');
            let count = 0;
            for (const msg of botMessages.values()) {
              try { await msg.delete(); count++; } catch (e) { }
            }
            await interaction.editReply(`Manually deleted **${count}** messages.`);
          } else {
            throw err;
          }
        }
      } else {
        await interaction.editReply('No messages to delete.');
      }
    } catch (e) {
      await interaction.editReply('Error deleting messages.');
    }
  }
});

const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Error: Token not found.');
} else {
  console.log(`Token found (Length: ${token.length})`);
}

client.on(Events.ClientReady, () => {
  console.log(`${client.user.tag} is online!`);

  client.user.setActivity('/nestle | v1.1.5', { type: ActivityType.Listening });
  console.log(`Stats: ${client.guilds.cache.size} Servers, ${client.users.cache.size} Users`);

  setInterval(() => {
    try {
      const statsRef = ref(db, 'stats/bot_status');
      set(statsRef, {
        ping: client.ws.ping,
        uptime: process.uptime(),
        servers: client.guilds.cache.size,
        users: client.users.cache.size,
        last_updated: Date.now()
      });

      const sessions = [];
      distube.voices.collection.forEach((voice) => {
        const voicePing = voice.connection?.ping?.udp ?? voice.connection?.ping?.ws ?? client.ws.ping;

        sessions.push({
          guildId: voice.id,
          name: voice.channel?.guild?.name || `Room #${voice.id.slice(-4)}`,
          ping: Math.round(voicePing),
          channelName: voice.channel?.name || 'Unknown'
        });
      });

      const sessionsRef = ref(db, 'stats/active_sessions');
      set(sessionsRef, sessions);

    } catch (err) { }
  }, 5000);
});

client.on('error', (error) => {
  console.error('Client Error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

client.login(token).catch(e => {
  console.error('Login Failed:', e);
});

const http = require('http');
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('System Ready.');
}).listen(port, () => {
  console.log(`HTTP Listener on ${port}`);
});
