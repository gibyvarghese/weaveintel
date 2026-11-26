---
'@weaveintel/connect': minor
---

New subpath `@weaveintel/connect/forms`: ask a person an application's form and submit their answers, the same way for every application. `fromDefinition` turns an application's own form definition (a catalogue item, issue create metadata, list columns) into one `FormSpec` through a declarative mapping a connector pack ships as data. `nextQuestions`/`applicable` follow the form's show, hide and require rules. `toElicitation`/`fromElicitation` ask through MCP elicitation (form mode). `validate`/`normalise` check answers and turn them into what the application accepts (choice values, lookup ids, and date-times converted from the person's time zone into the application's). `summarise` gives the answers in the person's words for the confirmation, and `guidedSubmit` runs the whole loop with asking, lookup and submit supplied by the caller.
