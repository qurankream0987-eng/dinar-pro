# Command 04 — D5 G2 and Negotiation

## G2

The D5 change runs inside the existing shared smart-turn runtime. Existing G2 inquiry and smart-conversation acceptance suites passed in the disposable PostgreSQL chain. No alternate conversation runtime, new surface, employee task state, customer-reply draft, approval action, or outbound sender was added.

Consequently, the following remain unimplemented for D5: an employee answering buyer quantity requests, drafting a reply for owner approval, sending an approved reply once, handling a tool retry as an employee, and resuming an employee task after reload.

## Negotiation

No negotiation tool or permission was added to the model. The existing universal negotiation and model-authority suites passed. Their results are regression evidence for current platform boundaries, not proof that D5 can negotiate or that a seller employee has a discount policy.

The D5 model context explicitly says that it grants no price changes, negotiation, or message-sending authority. A seller discount request must not be treated as accepted, countered, or sent by this employee.

## External effects

The tests used a loopback disposable PostgreSQL database. They did not send live customer messages, make payment operations, contact a real courier, or intentionally call an external model provider.
