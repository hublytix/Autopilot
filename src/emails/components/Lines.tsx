import { Fragment } from 'react';

// Plain text with its line breaks kept as <br />: `white-space: pre-wrap` is not honoured by every
// mail client nor by the plain-text part, so breaks are written out. React escapes every line.

export function Lines({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
    </>
  );
}
