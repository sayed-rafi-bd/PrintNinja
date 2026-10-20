import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn("border-b last:border-b-0", className)} {...props} />
));
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  // Radix renders the header as an <h3>. These sections sit directly under the page's <h1>,
  // so an <h2> keeps the heading levels in order.
  <AccordionPrimitive.Header asChild>
    <h2 className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        // min-h-11 on touch screens keeps the 44 px tap target.
        "group flex flex-1 items-center gap-2 py-3 text-left text-sm font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11",
        className,
      )}
      {...props}
    >
      <ChevronRight
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90"
        aria-hidden="true"
      />
      {children}
    </AccordionPrimitive.Trigger>
    </h2>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content ref={ref} className="overflow-hidden text-sm" {...props}>
    <div className={cn("pb-4", className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
