import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import Slack from 'slack-client';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';

const ALLOWED_SUBTYPES = ['me_message'];
const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError('Missing configuration field ' + field);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.slack = new Slack(options.token);

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.commandCharacters = options.commandCharacters || [];
    this.channels = _.values(options.channelMapping);

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, slackChan) => {
      this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
    }, this);

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];

    this.namesRequestsCounter = 0;
  }

  connect() {
    logger.debug('Connecting to IRC and Slack');
    this.slack.login();

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.slack.on('open', () => {
      logger.debug('Connected to Slack');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
    });

    this.slack.on('error', error => {
      logger.error('Received error event from Slack', error);
    });

    this.slack.on('message', message => {
      // Ignore bot messages and people leaving/joining
      if (message.type === 'message' &&
        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)) {
        if (message.text[0] == '%') {
          this.sendActionToIrc(message);
          return;
        }
        this.sendToIRC(message);
      }
    });

    this.ircClient.on('message', this.sendToSlack.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      const formattedText = '*' + text + '*';
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('action', (author, to, text) => {
      const formattedText = '_' + text + '_';
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    this.ircClient.on('join', (channel, nick, message) => {
      logger.debug('User joined:', nick);
      this.sendToSlack(this.nickname, channel, "*" + nick + "* joined _" + channel + "_ :green_heart:");
    });

    this.ircClient.on('names', (channel, nicks) => {
      if (this.namesRequestsCounter == 0) {
        return;
      }
      this.namesRequestsCounter--;
      var text = "connected users:\r\n```";
      for(var nick in nicks) {
        text += nick + "\r\n";
      }
      text += '```';
      this.sendToSlack(this.nickname, channel, text);
    });
  }

  parseText(text) {
    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#(C\w+)\|?(\w+)?>/g, (match, channelId, readable) => {
        const { name } = this.slack.getChannelByID(channelId);
        return readable || `#${name}`;
      })
      .replace(/<@(U\w+)\|?(\w+)?>/g, (match, userId, readable) => {
        const { name } = this.slack.getUserByID(userId);
        return readable || `@${name}`;
      })
      .replace(/<(?!!)(\S+)>/g, (match, link) => link)
      .replace(/<!(\w+)\|?(\w+)?>/g, (match, command, label) =>
        `<${label || command}>`
      )
      .replace(/\:(\w+)\:/g, (match, emoji) => {
        if (emoji in emojis) {
          return emojis[emoji];
        }

        return match;
      });
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendActionToIrc(message) {
    const channel = this.slack.getChannelGroupOrDMByID(message.channel);
    if (!channel) {
      logger.info('Received message from a channel the bot isn\'t in:',
          message.channel);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const user = this.slack.getUserByID(message.user);
      var cmd = message.getBody().substring(1);
      if (cmd.toLowerCase() == "names") {
        this.namesRequestsCounter++;
      }
      let text = this.parseText(cmd);

      logger.debug('Sending command to IRC', channelName, text);
      this.ircClient.send(text, ircChannel);
    }
  }

  sendToIRC(message) {
    const channel = this.slack.getChannelGroupOrDMByID(message.channel);
    if (!channel) {
      logger.info('Received message from a channel the bot isn\'t in:',
        message.channel);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const user = this.slack.getUserByID(message.user);
      let text = this.parseText(message.getBody());

      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Slack by ${user.name}:`;
        this.ircClient.say(ircChannel, prelude);
      } else if (!message.subtype) {
        text = `<${user.name}> ${text}`;
      } else if (message.subtype === 'me_message') {
        text = `Action: ${user.name} ${text}`;
      }

      logger.debug('Sending message to IRC', channelName, text);
      this.ircClient.say(ircChannel, text);
    }
  }

  sendToSlack(author, channel, text) {
    const slackChannelName = this.invertedMapping[channel.toLowerCase()];
    if (slackChannelName) {
      const slackChannel = this.slack.getChannelGroupOrDMByName(slackChannelName);

      if (!slackChannel) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          slackChannelName);
        return;
      }

      const message = {
        text: text,
        username: author,
        parse: 'full',
        icon_url: `http://api.adorable.io/avatars/48/${author}.png`
      };

      logger.debug('Sending message to Slack', message, channel, '->', slackChannelName);
      slackChannel.postMessage(message);
    }
  }
}

export default Bot;
