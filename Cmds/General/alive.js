//alive.js

module.exports = async (context) => {
    const { client, m, prefix } = context;

const botname = process.env.BOTNAME || "MICKEY-TECH";

 await client.sendMessage(m.chat, { image: { url: 'https://ibb.co/L275xWK' }, caption: `Hello ${m.pushName}, Mickey-tech is active now.\n\nType ${prefix}menu to see my command list..\n\nDont forget to fork and star my repo \.\n\nXd );`, fileLength: "9999999999898989899999999" }, { quoted: m }); 

}
