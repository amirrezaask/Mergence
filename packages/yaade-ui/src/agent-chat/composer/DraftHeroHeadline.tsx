export function DraftHeroHeadline(props: {
  title?: string
  subtitle?: string
}) {
  return (
    <div
      className="mx-auto mb-6 flex w-full max-w-3xl flex-col items-center gap-2 px-4 text-center"
      data-chat-draft-hero=""
    >
      <h1 className="text-balance font-semibold text-2xl tracking-tight text-foreground sm:text-3xl">
        {props.title ?? "What should we work on?"}
      </h1>
      {props.subtitle ? (
        <p className="max-w-xl text-pretty text-sm text-muted-foreground">{props.subtitle}</p>
      ) : null}
    </div>
  )
}
