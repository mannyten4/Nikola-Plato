/** Wrap plain text in a Slack Block Kit section */
export function textBlock(text: string): Array<{ type: string; text: { type: string; text: string } }> {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}
