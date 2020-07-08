const axios = require('axios');
const moment = require('moment');
const express = require('express');
const Discord = require('discord.js');
const Cloudant = require('@cloudant/cloudant');
require('dotenv').config();
// INIT CLIENTS
const discordClient = new Discord.Client();
const cloudantClient = Cloudant({
    url: process.env.CLOUDANT_URL,
    plugins: {
        iamauth: {
            iamApiKey: process.env.CLOUDANT_API_KEY
        }
    }
});
const cloudantDb = cloudantClient.db.use('twitch-info');

const checkLiveStreamers = async () => {
    const dummyTwitchChannelInfo = await verifyTwitchToken();
    if (dummyTwitchChannelInfo) {
        loopThroughChannelList();
    }
};

const loopThroughChannelList = async () => {
    try {
        const result = await cloudantDb.find({
            selector: {
                _id: {
                    $gt: '0'
                }
            }
        });
        for (let i = 0; i < result.docs.length; i++) {
            let cloudantDoc = result.docs[i];
            console.log('loopThroughChannelList', '==> Processing ' + cloudantDoc['twitch_user_name']);
            // get user info
            const currentDateTime = moment();
            if (
                cloudantDoc['twitch_user'] &&
                cloudantDoc['twitch_user']['timestamp'] &&
                currentDateTime.diff(moment(cloudantDoc['twitch_user']['timestamp']), 'minutes') < 60
            ) {
                console.log('loopThroughChannelList', 'Using TwitchUserInfo from CloudantDB as cache');
            } else {
                console.log('loopThroughChannelList', 'No TwitchUserInfo or 1hour delay passed');
                // get user info from Twitch API
                const twitchUserInfo = await getTwitchUserInfo(cloudantDoc['twitch_user_name']);
                if (twitchUserInfo) {
                    console.log('loopThroughChannelList', 'Got updated TwitchUserInfo');
                    // set timestamp that we use to compare later so we do not need to query Twitch to many times
                    twitchUserInfo['timestamp'] = moment().valueOf();
                    cloudantDoc['twitch_user'] = twitchUserInfo;
                    // Update document in CloudantDB
                    //cloudantDoc = await cloudantDb.insert(cloudantDoc);
                }
            }
            // get channel info
            if (
                cloudantDoc['twitch_channel'] &&
                cloudantDoc['twitch_channel']['timestamp'] &&
                currentDateTime.diff(moment(cloudantDoc['twitch_channel']['timestamp']), 'minutes') < 60
            ) {
                console.log('loopThroughChannelList', 'Using TwitchChannelInfo from CloudantDB as cache');
            } else {
                console.log('loopThroughChannelList', 'No TwitchChannelInfo or 1hour delay passed');
                // get channel info from Twitch API
                const twitchChannelInfo = await getTwitchChannelInfo(cloudantDoc['twitch_user_name']);
                if (twitchChannelInfo) {
                    console.log('loopThroughChannelList', 'Got updated TwitchChannelInfo');
                    // set timestamp that we use to compare later so we do not need to query Twitch to many times
                    twitchChannelInfo['timestamp'] = moment().valueOf();
                    cloudantDoc['twitch_channel'] = twitchChannelInfo;
                    // Update document in CloudantDB
                    //cloudantDoc = await cloudantDb.insert(cloudantDoc);
                }
            }
            // check if online
            if (cloudantDoc['twitch_user']) {
                console.log('loopThroughChannelList', 'TwitchUserInfo found, process to check if user streaming');
                const twitchLiveStreamInfo = await getTwitchLiveStreamInfo(cloudantDoc['twitch_user']['id']);
                // if we get live stream data, send message to discord
                if (twitchLiveStreamInfo) {
                    console.log('loopThroughChannelList', 'User is streaming');
                    const twitchGameInfo = await getTwitchGameInfo(twitchLiveStreamInfo['game_id']);
                    twitchLiveStreamInfo['twitch_game'] = twitchGameInfo;
                    // if stream timestamp is different, then we send notification
                    console.log(
                        'loopThroughChannelList',
                        'Check timestamp of live stream: CloudantDB:' +
                            cloudantDoc['discord_notification_started_at'] +
                            ', Twitch:' +
                            twitchLiveStreamInfo['started_at']
                    );
                    if (cloudantDoc['discord_notification_started_at'] !== twitchLiveStreamInfo['started_at']) {
                        console.log('loopThroughChannelList', 'Notification not sent, send to discord');
                        sendDiscordNotification(cloudantDoc, twitchLiveStreamInfo);
                    } else {
                        console.log('loopThroughChannelList', 'Notification for live stream already sent');
                    }
                    cloudantDoc['discord_notification_started_at'] = twitchLiveStreamInfo['started_at'];
                    //cloudantDoc = await cloudantDb.insert(cloudantDoc);
                } else {
                    console.log('loopThroughChannelList', 'User not streaming');
                }
            } else {
                console.log('loopThroughChannelList', 'No TwitchUserInfo for checking if user streaming');
            }
            cloudantDb.insert(cloudantDoc);
        }
    } catch (err) {
        console.log('ERROR loopThroughChannelList', err);
    }
};

const getTwitchUserInfo = async (twitchUserName) => {
    let twitchUserInfo = null;
    try {
        const response = await axios.get('https://api.twitch.tv/helix/users?login=' + twitchUserName, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data && response.data.data && response.data.data[0]) {
            twitchUserInfo = response.data.data[0];
        }
    } catch (err) {
        console.log('ERROR getTwitchUserInfo', err);
    }
    return twitchUserInfo;
};

const getTwitchChannelInfo = async (twitchChannelName) => {
    let twitchChannelInfo = null;
    try {
        const response = await axios.get('https://api.twitch.tv/helix/search/channels?query=' + twitchChannelName, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data && response.data.data && response.data.data[0]) {
            twitchChannelInfo = response.data.data[0];
        }
    } catch (err) {
        console.log('ERROR getTwitchChannelInfo', err);
    }
    return twitchChannelInfo;
};

const getTwitchLiveStreamInfo = async (twitchUserId) => {
    let twitchLiveStreamInfo = null;
    try {
        const response = await axios.get('https://api.twitch.tv/helix/streams?user_id=' + twitchUserId, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data && response.data.data && response.data.data[0]) {
            twitchLiveStreamInfo = response.data.data[0];
        }
    } catch (err) {
        console.log('ERROR getTwitchLiveStreamInfo', err);
    }
    return twitchLiveStreamInfo;
};

const getTwitchGameInfo = async (twitchGameId) => {
    let twitchGameInfo = null;
    try {
        const response = await axios.get('https://api.twitch.tv/helix/games?id=' + twitchGameId, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data && response.data.data && response.data.data[0]) {
            twitchGameInfo = response.data.data[0];
        }
    } catch (err) {
        console.log('ERROR getTwitchGameInfo', err);
    }
    return twitchGameInfo;
};

const verifyTwitchToken = async () => {
    let twitchChannelInfo = null;
    try {
        const response = await axios.get('https://api.twitch.tv/helix/channels?broadcaster_id=48212629', {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data && response.data.data && response.data.data[0]) {
            twitchChannelInfo = response.data.data[0];
        }
        console.log('verifyTwitchToken', 'Token still valid');
    } catch (err) {
        console.log('ERROR verifyTwitchToken', err);
        if (err && err.response && err.response.status === 401) {
            const response = await axios.post(
                'https://id.twitch.tv/oauth2/token?client_id=' +
                    process.env.TWITCH_CLIENTID +
                    '&client_secret=' +
                    process.env.TWITCH_SECRET +
                    '&grant_type=client_credentials'
            );
            if (response.data && response.data.access_token) {
                console.log('verifyTwitchToken', 'Got new token');
                process.env.TWITCH_TOKEN = response.data.access_token;
            }
        }
    }
    return twitchChannelInfo;
};

const sendDiscordNotification = (cloudantDoc, twitchLiveStreamInfo) => {
    discordClient.channels.fetch(cloudantDoc['discord_channel_id']).then((channel) => {
        const embed = new Discord.MessageEmbed({
            type: 'rich'
        });
        if (cloudantDoc['twitch_user']) {
            embed.setAuthor(
                cloudantDoc['twitch_user']['display_name'],
                cloudantDoc['twitch_user']['profile_image_url'] + '?ts=' + moment().valueOf(),
                'https://twitch.tv/' + cloudantDoc['twitch_user']['login']
            );
            embed.setURL('https://twitch.tv/' + cloudantDoc['twitch_user']['login']);
            embed.setThumbnail(cloudantDoc['twitch_user']['profile_image_url'] + '?ts=' + moment().valueOf());
            if (cloudantDoc['twitch_user']['description']) {
                embed.setDescription(cloudantDoc['twitch_user']['description']);
            }
        }
        embed.setTitle(twitchLiveStreamInfo['title']);
        let thumbnailUrl = twitchLiveStreamInfo['thumbnail_url'].replace(/{width}/g, '1920');
        thumbnailUrl = thumbnailUrl.replace(/{height}/g, '1080');
        embed.setImage(thumbnailUrl + '?ts=' + moment().valueOf());
        if (twitchLiveStreamInfo['twitch_game']) {
            embed.addField('Game', twitchLiveStreamInfo['twitch_game']['name'], true);
        }
        embed.addField('Viewers', twitchLiveStreamInfo['viewer_count'], true);
        embed.setFooter('Started streaming');
        embed.setTimestamp(twitchLiveStreamInfo['started_at']);
        let message = 'Hey @everyone! Come watch this awesome streamer!';
        if (cloudantDoc['discord_custom_message']) {
            message = cloudantDoc['discord_custom_message'];
        }
        channel.send(message, embed);
    });
};

discordClient.on('ready', () => {
    console.log(`Logged in as ${discordClient.user.tag}!`);
    checkLiveStreamers();
    setInterval(checkLiveStreamers, 5 * 60 * 1000);
});

discordClient.login(process.env.DISCORD_TOKEN);

const app = express();
app.get('/_ah/warmup', (req, res) => {
    res.sendStatus(200);
});
app.listen(8080);
