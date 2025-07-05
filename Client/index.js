const baz = 'a'
const {
  default: dreadedConnect,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  jidDecode,
  proto,
  getContentType,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const FileType = require("file-type");
const { exec, spawn, execSync } = require("child_process");
const axios = require("axios");
const express = require("express");
const app = express();
const port = process.env.PORT || 10000;
const _ = require("lodash");
const PhoneNumber = require("awesome-phonenumber");
const NodeCache = require("node-cache");
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('../lib/exif');
const { isUrl, generateMessageTag, getBuffer, getSizeMedia, fetchJson, await, sleep } = require('../lib/botFunctions');
const handleDreaded = require("./dreaded");

const { initializeClientUtils } = require('../Client/clientUtils'); 

const logger = pino({
    level: 'silent' 
});
const makeInMemoryStore = require('../Client/store.js'); 

const store = makeInMemoryStore({
    logger: logger.child({
        stream: 'store'
    })
});

const groupCache = require("../Client/groupCache");

const authenticationn = require('../Auth/auth.js');
const { smsg } = require('../Handler/smsg');
const { getSettings, getBannedUsers, banUser, getGroupSetting } = require("../Database/adapter");

const { botname } = require('../Env/settings');
const { DateTime } = require('luxon');
const { commands, totalCommands } = require('../Handler/commandHandler');
authenticationn();

const path = require('path');
const sessionName = path.join(__dirname, '..', 'Session'); 

const groupEvents = require("../Handler/eventHandler");
const groupEvents2 = require("../Handler/eventHandler2");
const connectionHandler = require('../Handler/connectionHandler');

let cachedSettings = null;
let lastSettingsFetch = 0;
const SETTINGS_CACHE_DURATION = 10_000;

async function getCachedSettings() {
  const now = Date.now();
  if (!cachedSettings || now - lastSettingsFetch > SETTINGS_CACHE_DURATION) {
    cachedSettings = await getSettings();
    lastSettingsFetch = now;
  }
  return cachedSettings;
}

async function startDreaded() {
    let settings = await getCachedSettings();
    if (!settings) return;

    const { autobio, mode, anticall } = settings;

    const { saveCreds, state } = await useMultiFileAuthState(sessionName)
    const client = dreadedConnect({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        version: [2, 3000, 1023223821],
        browser: [`DREADED`,'Safari','3.0'],
        fireInitQueries: false,
        shouldSyncHistoryMessage: true,
        downloadHistory: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30_000,
        auth: state,
        
        cachedGroupMetadata: async (jid) => {
            const cached = groupCache.get(jid);
            if (cached) {
                console.log(`Using cached metadata for group: ${jid}`);
                return cached;
            }
            return null;
        },
        getMessage: async (key) => {
            if (store) {
                const mssg = await store.loadMessage(key.remoteJid, key.id)
                return mssg.message || undefined
            }
            return {
                conversation: "HERE"
            }
        }
    });

    
    initializeClientUtils(client, store, groupCache);

    store.bind(client.ev);

    setInterval(() => { store.writeToFile("store.json"); }, 3000);

client.ev.on("connection.update", async (update) => {
  await connectionHandler(client, update, startDreaded);
}); 

    
    

    client.ev.on('group-participants.update', async (event) => {
        try {
            console.log(`Group participants updated: ${event.id}`);
            const metadata = await client.groupMetadata(event.id);
            groupCache.set(event.id, metadata);
            console.log(`Updated cached metadata for group: ${event.id}`);
            
            
            groupEvents(client, event);
            groupEvents2(client, event);
        } catch (error) {
            console.error(`Error updating group metadata cache for ${event.id}:`, error);
           
            groupEvents(client, event);
            groupEvents2(client, event);
        }
    });

    const processedCalls = new Set();

    client.ws.on('CB:call', async (json) => {
        const settings = await getCachedSettings();
        if (!settings?.anticall) return;
        const callId = json.content[0].attrs['call-id'];
        const callerJid = json.content[0].attrs['call-creator'];
        const callerNumber = callerJid.replace(/[@.a-z]/g, "");

        if (processedCalls.has(callId)) {
            return;
        }
        processedCalls.add(callId);

        try {
            await client.rejectCall(callId, callerJid);
            await client.sendMessage(callerJid, { text: "You will be banned for calling. Contact the owner!" });

            const bannedUsers = await getBannedUsers();
            if (!bannedUsers.includes(callerNumber)) {
                await banUser(callerNumber);
            }
        } catch (error) {
            console.error('Error handling call:', error);
        }
    });

    client.ev.on("messages.upsert", async (chatUpdate) => {

        const settings = await getCachedSettings(); 
        if (!settings) return;

        const { autoread, autolike, autoview, presence, reactEmoji } = settings;

        try {
            mek = chatUpdate.messages[0];
            if (!mek.message) return;

            mek.message = Object.keys(mek.message)[0] === "ephemeralMessage" ? mek.message.ephemeralMessage.message : mek.message;

            const messageContent = mek.message.conversation || mek.message.extendedTextMessage?.text || "";
            const isGroup = mek.key.remoteJid.endsWith("@g.us");
            const sender = mek.key.participant || mek.key.remoteJid;
            const Myself = await client.decodeJid(client.user.id);

            if (isGroup) {
                const antilink = await getGroupSetting(mek.key.remoteJid, "antilink");

                if ((antilink === true || antilink === 'true') && messageContent.includes("https") && groupSender !== Myself) {
                
                   const groupAdmins = await client.getGroupAdmins(mek.key.remoteJid);
                    const isAdmin = groupAdmins.includes(sender);
                    const isBotAdmin = groupAdmins.includes(Myself);

                    if (!isBotAdmin) return;
                    if (!isAdmin) {
                        await client.sendMessage(mek.key.remoteJid, {
                            text: `🚫 @${groupSender.split("@")[0]}, sending links is prohibited! You have been removed.`,
                            contextInfo: { mentionedJid: [sender] }
                        }, { quoted: mek });

                        await client.groupParticipantsUpdate(mek.key.remoteJid, [groupSender], "remove");

                        await client.sendMessage(mek.key.remoteJid, {
                            delete: {
                                remoteJid: mek.key.remoteJid,
                                fromMe: false,
                                id: mek.key.id,
                                participant: groupSender
                            }
                        });
                    }
                    return;
                }
            }

            // autolike for statuses
            

if (autolike && mek.key && mek.key.remoteJid === "status@broadcast") {
        const nickk = await client.decodeJid(client.user.id);
        const emojis = ['🗿', '⌚️', '💠', '👣', '🍆', '💔', '🤍', '❤️‍🔥', '💣', '🧠', '🦅', '🌻', '🧊', '🛑', '🧸', '👑', '📍', '😅', '🎭', '🎉', '😳', '💯', '🔥', '💫', '🐒', '💗', '❤️‍🔥', '👁️', '👀', '🙌', '🙆', '🌟', '💧', '🦄', '🟢', '🎎', '✅', '🥱', '🌚', '💚', '💕', '😉', '😒'];
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        await client.sendMessage(mek.key.remoteJid, { react: { text: randomEmoji, key: mek.key, } }, { statusJidList: [mek.key.participant, nickk] });
       
   console.log('Reaction sent successfully✅️');
          }

            // autoview/ autoread
            if (autoview && mek.key.remoteJid === "status@broadcast") {
                await client.readMessages([mek.key]);
            } else if (autoread && mek.key.remoteJid.endsWith('@s.whatsapp.net')) {
                await client.readMessages([mek.key]);
            }

            // presence
            if (mek.key.remoteJid.endsWith('@s.whatsapp.net')) {
                const Chat = mek.key.remoteJid;
                if (presence === 'online') {
                    await client.sendPresenceUpdate("available", Chat);
                } else if (presence === 'typing') {
                    await client.sendPresenceUpdate("composing", Chat);
                } else if (presence === 'recording') {
                    await client.sendPresenceUpdate("recording", Chat);
                } else {
                    await client.sendPresenceUpdate("unavailable", Chat);
                }
            }

            // handle commands
            if (!client.public && !mek.key.fromMe && chatUpdate.type === "notify") return;

            const m = smsg(client, mek, store);
            handleDreaded(client, m, chatUpdate, store);

        } catch (err) {
            console.log(err);
        }
    });

    // Handle error
    const unhandledRejections = new Map();
    process.on("unhandledRejection", (reason, promise) => {
        unhandledRejections.set(promise, reason);
        console.log("Unhandled Rejection at:", promise, "reason:", reason);
    });
    process.on("rejectionHandled", (promise) => {
        unhandledRejections.delete(promise);
    });
    process.on("Something went wrong", function (err) {
        console.log("Caught exception: ", err);
    });

    client.public = true;
    client.serializeM = (m) => smsg(client, m, store);

    client.ev.on("connection.update", async (update) => {
        await connectionHandler(client, update, startDreaded);
    });

    client.ev.on("creds.update", saveCreds);
}

app.use(express.static('public'));

app.get("/", (req, res) => {
    res.sendFile(__dirname + '/index.html'); 
});

app.listen(port, () => console.log(`Server listening on port http://localhost:${port}`));

startDreaded();

module.exports = startDreaded;

let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`Update ${__filename}`));
    delete require.cache[file];
    require(file);
});
