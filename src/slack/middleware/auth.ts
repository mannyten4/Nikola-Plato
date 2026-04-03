import { config } from '../../config';

export function isAllowedChannel(channel: string): boolean {
  return channel === config.slack.channelId;
}
