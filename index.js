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
    const dummyTwitchChannelInfo = await verifyOrRefreshTwitchToken();
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
            console.log('loopThroughChannelList', '=====> Processing ' + cloudantDoc['twitch_user_name']);
            const currentDateTime = moment();
            // get user info
            await getUpdatedTwitchUserInfo(cloudantDoc, currentDateTime);
            // get channel info
            await getUpdatedTwitchChannelInfo(cloudantDoc, currentDateTime);
            // check if online
            await checkTwitchUserIsStreaming(cloudantDoc);
            // Update CloudantDB with the new info
            cloudantDb.insert(cloudantDoc);
            console.log('loopThroughChannelList', '<===== Done Processing ' + cloudantDoc['twitch_user_name']);
        }
    } catch (err) {
        console.log('ERROR loopThroughChannelList', err);
    }
};

const getUpdatedTwitchChannelInfo = async (cloudantDoc, currentDateTime) => {
    if (
        cloudantDoc['twitch_channel'] &&
        cloudantDoc['twitch_channel']['timestamp'] &&
        currentDateTime.diff(moment(cloudantDoc['twitch_channel']['timestamp']), 'minutes') < 60
    ) {
        console.log('getUpdatedTwitchChannelInfo', 'Using TwitchChannelInfo from CloudantDB as cache');
    } else {
        console.log('getUpdatedTwitchChannelInfo', 'No TwitchChannelInfo or 1hour delay passed');
        // get channel info from Twitch API
        const twitchChannelInfo = await fetchTwitchChannelInfo(cloudantDoc['twitch_user_name']);
        if (twitchChannelInfo) {
            console.log('getUpdatedTwitchChannelInfo', 'Got updated TwitchChannelInfo');
            // set timestamp that we use to compare later so we do not need to query Twitch to many times
            twitchChannelInfo['timestamp'] = moment().valueOf();
            cloudantDoc['twitch_channel'] = twitchChannelInfo;
        }
    }
};

const getUpdatedTwitchUserInfo = async (cloudantDoc, currentDateTime) => {
    if (
        cloudantDoc['twitch_user'] &&
        cloudantDoc['twitch_user']['timestamp'] &&
        currentDateTime.diff(moment(cloudantDoc['twitch_user']['timestamp']), 'minutes') < 60
    ) {
        console.log('getUpdatedTwitchUserInfo', 'Using TwitchUserInfo from CloudantDB as cache');
    } else {
        console.log('getUpdatedTwitchUserInfo', 'No TwitchUserInfo or 1hour delay passed');
        // get user info from Twitch API
        const twitchUserInfo = await fetchTwitchUserInfo(cloudantDoc['twitch_user_name']);
        if (twitchUserInfo) {
            console.log('getUpdatedTwitchUserInfo', 'Got updated TwitchUserInfo');
            // set timestamp that we use to compare later so we do not need to query Twitch to many times
            twitchUserInfo['timestamp'] = moment().valueOf();
            cloudantDoc['twitch_user'] = twitchUserInfo;
        }
    }
};

const checkTwitchUserIsStreaming = async (cloudantDoc) => {
    if (cloudantDoc['twitch_user']) {
        console.log('checkTwitchUserIsStreaming', 'TwitchUserInfo found, process to check if user streaming');
        const twitchLiveStreamInfo = await fetchTwitchLiveStreamInfo(cloudantDoc['twitch_user']['id']);
        // if we get live stream data, send message to discord
        if (twitchLiveStreamInfo) {
            console.log('checkTwitchUserIsStreaming', 'User is streaming');
            const twitchGameInfo = await fetchTwitchGameInfo(twitchLiveStreamInfo['game_id']);
            twitchLiveStreamInfo['twitch_game'] = twitchGameInfo;
            // if stream timestamp is different, then we send notification
            console.log(
                'checkTwitchUserIsStreaming',
                'Check timestamp of live stream: CloudantDB:' +
                    cloudantDoc['discord_notification_started_at'] +
                    ', Twitch:' +
                    twitchLiveStreamInfo['started_at']
            );
            if (cloudantDoc['discord_notification_started_at'] !== twitchLiveStreamInfo['started_at']) {
                console.log('checkTwitchUserIsStreaming', 'Notification not sent, send to discord');
                const discordMessage = await sendDiscordNotification(cloudantDoc, twitchLiveStreamInfo);
                cloudantDoc['discord_notification_message_id'] = discordMessage.id;
                const twitchVideoInfo = await fetchTwitchVideoInfo(
                    cloudantDoc['twitch_user']['id'],
                    twitchLiveStreamInfo['title']
                );
                cloudantDoc['twitch_stream_vod'] = twitchVideoInfo;
            } else {
                console.log('checkTwitchUserIsStreaming', 'Notification for live stream already sent');
                let hasStreamVod = false;
                if (cloudantDoc['twitch_stream_vod']) {
                    if (cloudantDoc['twitch_stream_vod']['title'] === twitchLiveStreamInfo['title']) {
                        console.log('checkTwitchUserIsStreaming', 'Already got stream VOD');
                        hasStreamVod = true;
                    }
                }
                if (!hasStreamVod) {
                    console.log('checkTwitchUserIsStreaming', 'No stream VOD, try to get VOD');
                    const twitchVideoInfo = await fetchTwitchVideoInfo(
                        cloudantDoc['twitch_user']['id'],
                        twitchLiveStreamInfo['title']
                    );
                    cloudantDoc['twitch_stream_vod'] = twitchVideoInfo;
                }
            }
            cloudantDoc['discord_notification_started_at'] = twitchLiveStreamInfo['started_at'];
        } else {
            console.log('checkTwitchUserIsStreaming', 'User not streaming');
            if (cloudantDoc['discord_notification_message_id']) {
                const discordMessage = await editDiscordNotification(cloudantDoc);
                console.log('checkTwitchUserIsStreaming', 'Edited notification with VOD link');
                cloudantDoc['discord_notification_message_id'] = '';
                cloudantDoc['discord_notification_started_at'] = '';
                cloudantDoc['twitch_stream_vod'] = null;
            }
        }
    } else {
        console.log('checkTwitchUserIsStreaming', 'No TwitchUserInfo for checking if user streaming');
    }
};

const fetchTwitchUserInfo = async (twitchUserName) => {
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
        console.log('ERROR fetchTwitchUserInfo', err);
    }
    return twitchUserInfo;
};

const fetchTwitchChannelInfo = async (twitchChannelName) => {
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
        console.log('ERROR fetchTwitchChannelInfo', err);
    }
    return twitchChannelInfo;
};

const fetchTwitchLiveStreamInfo = async (twitchUserId) => {
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
        console.log('ERROR fetchTwitchLiveStreamInfo', err);
    }
    return twitchLiveStreamInfo;
};

const fetchTwitchGameInfo = async (twitchGameId) => {
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
        console.log('ERROR fetchTwitchGameInfo', err);
    }
    return twitchGameInfo;
};

const fetchTwitchVideoInfo = async (twitchUserId, liveStreamTitle) => {
    let twitchVideoInfo = null;
    try {
        const response = await axios.get(
            'https://api.twitch.tv/helix/videos?user_id=' + twitchUserId + '&type=archive',
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENTID,
                    Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
                }
            }
        );
        if (response.data && response.data.data && response.data.data[0]) {
            if (response.data.data[0].title === liveStreamTitle) {
                twitchVideoInfo = response.data.data[0];
            }
        }
    } catch (err) {
        console.log('ERROR fetchTwitchVideoInfo', err);
    }
    return twitchVideoInfo;
};

const verifyOrRefreshTwitchToken = async () => {
    let tokenIsValid = false;
    try {
        const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENTID,
                Authorization: 'Bearer ' + process.env.TWITCH_TOKEN
            }
        });
        if (response.data) {
            tokenIsValid = true;
        }
        console.log('verifyOrRefreshTwitchToken', 'Token still valid');
    } catch (err) {
        console.log('ERROR verifyOrRefreshTwitchToken', err);
        if (err && err.response && err.response.status === 401) {
            const response = await axios.post(
                'https://id.twitch.tv/oauth2/token?client_id=' +
                    process.env.TWITCH_CLIENTID +
                    '&client_secret=' +
                    process.env.TWITCH_SECRET +
                    '&grant_type=client_credentials'
            );
            if (response.data && response.data.access_token) {
                console.log('verifyOrRefreshTwitchToken', 'Got new token');
                process.env.TWITCH_TOKEN = response.data.access_token;
                tokenIsValid = true;
            }
        }
    }
    return tokenIsValid;
};

const sendDiscordNotification = async (cloudantDoc, twitchLiveStreamInfo) => {
    const channel = await discordClient.channels.fetch(cloudantDoc['discord_channel_id']);
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
    //embed.addField('Viewers', twitchLiveStreamInfo['viewer_count'], true);
    embed.setFooter('Started streaming');
    embed.setTimestamp(twitchLiveStreamInfo['started_at']);
    let customMessage = 'Hey everyone! Come watch this awesome streamer!';
    if (cloudantDoc['discord_custom_message']) {
        customMessage = cloudantDoc['discord_custom_message'];
    }
    const discordMessage = await channel.send(customMessage, embed);
    return discordMessage;
};

const editDiscordNotification = async (cloudantDoc) => {
    const channel = await discordClient.channels.fetch(cloudantDoc['discord_channel_id']);
    const message = await channel.messages.fetch(cloudantDoc['discord_notification_message_id']);
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
        if (cloudantDoc['twitch_user']['offline_image_url']) {
            embed.setImage(cloudantDoc['twitch_user']['offline_image_url'] + '?ts=' + moment().valueOf());
        }
    }
    embed.setFooter('Last online');
    embed.setTimestamp(moment());
    let customMessage = cloudantDoc['twitch_user']['display_name'] + ' is not online anymore.';
    if (cloudantDoc['twitch_stream_vod']) {
        embed.setTitle(cloudantDoc['twitch_stream_vod']['title']);
        embed.addField('VOD', '[Link](' + cloudantDoc['twitch_stream_vod']['url'] + ')');
        customMessage += ' Check out the VOD!';
    }
    const discordMessage = await message.edit(customMessage, embed);
    return discordMessage;
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
