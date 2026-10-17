import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Printer, Upload, CheckCircle2, Zap } from "lucide-react";

const STEPS = [
  {
    title: "Add a Printer",
    description: "Configure your first printer (Wi-Fi, USB, Bluetooth, or system)",
    icon: Printer,
    action: "Add Printer",
  },
  {
    title: "Load a Template",
    description: "Create or import your first HTML template",
    icon: Upload,
    action: "New Template",
  },
  {
    title: "Test Print",
    description: "Send a test print to verify everything works",
    icon: Zap,
    action: "Test Print",
  },
  {
    title: "Done!",
    description: "PrintNinja is ready to use",
    icon: CheckCircle2,
    action: "Get Started",
  },
];

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  const currentStep = STEPS[step];
  const progress = Math.min(100, Math.max(0, ((step) / (STEPS.length - 1)) * 100));

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full bg-primary/10">
              <currentStep.icon className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">{currentStep.title}</CardTitle>
          <p className="text-muted-foreground">{currentStep.description}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Step {step + 1} of {STEPS.length}</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="flex gap-3 pt-4">
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button className="flex-1" onClick={handleNext}>
              {currentStep.action}
            </Button>
          </div>
          <div className="text-center">
            <button type="button" onClick={onComplete} className="text-xs text-muted-foreground hover:text-foreground underline">
              Skip onboarding — don’t show again
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
