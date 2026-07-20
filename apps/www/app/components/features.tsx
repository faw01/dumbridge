const features = [
  {
    description:
      "Every read fetches the file as it sits on your disk right now. There is no snapshot, no sync step, and nothing is uploaded ahead of time.",
    title: "Live",
  },
  {
    description:
      "The agent can only read below the directory you serve. It can never write to your disk, and it never executes your shell.",
    title: "Read-only",
  },
  {
    description:
      "Bytes cross the bridge over iroh QUIC with TLS pinned to your machine's key, so even a TLS-intercepting proxy cannot read them.",
    title: "Encrypted",
  },
];

export const Features = () => (
  <section className="border-t">
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-10 px-6 py-20 md:grid-cols-3 md:py-28">
      {features.map((feature) => (
        <div className="flex flex-col gap-3" key={feature.title}>
          <h3 className="font-semibold text-xl tracking-tight">
            {feature.title}
          </h3>
          <p className="text-muted-foreground leading-relaxed tracking-tight">
            {feature.description}
          </p>
        </div>
      ))}
    </div>
  </section>
);
