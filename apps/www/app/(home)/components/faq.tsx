import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@repo/design-system/components/ui/accordion";
import { Button } from "@repo/design-system/components/ui/button";
import { MoveRight } from "lucide-react";
import Link from "next/link";

const setupNotes = [
  {
    answer:
      "Set Network access to Full in the environment settings, put the DUMBRIDGE_KEY value in the agent's environment, and you are done.",
    question: "Claude Code on the web",
  },
  {
    answer:
      "Set the Domain allowlist to All (unrestricted), put the DUMBRIDGE_KEY value in the agent's environment, and you are done.",
    question: "Codex Cloud",
  },
  {
    answer:
      "Works with no extra setup. Put the DUMBRIDGE_KEY value in the agent's environment and start reading.",
    question: "Cursor",
  },
];

export const FAQ = () => (
  <div className="w-full py-20 lg:py-40">
    <div className="container mx-auto">
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h4 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
                Point your cloud agent at it
              </h4>
              <p className="max-w-xl text-left text-lg text-muted-foreground leading-relaxed tracking-tight lg:max-w-lg">
                serve prints a DUMBRIDGE_KEY. Hand it to the agent as an
                environment secret and the agent can run and pull against your
                served directory. If a connection fails, dumbridge doctor
                diagnoses the environment.
              </p>
            </div>
            <div>
              <Button asChild className="gap-4" variant="outline">
                <Link href="https://github.com/faw01/dumbridge#readme">
                  Read the quickstart <MoveRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
        <Accordion className="w-full" collapsible type="single">
          {setupNotes.map((item) => (
            <AccordionItem key={item.question} value={item.question}>
              <AccordionTrigger>{item.question}</AccordionTrigger>
              <AccordionContent>{item.answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  </div>
);
