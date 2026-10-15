import { z } from "zod";
import { cpf } from "cpf-cnpj-validator";

const optionalCpf = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v === "" || cpf.isValid(v), "CPF inválido")
  .transform((v) => (v === "" ? null : v));

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v === "" || (v.length >= 10 && v.length <= 11), "Telefone inválido")
  .transform((v) => (v === "" ? null : v));

export const signupSchema = z
  .object({
    fullName: z.string().trim().min(3, "Informe seu nome completo"),
    email: z.string().trim().email("Email inválido"),
    phone,
    cpf: optionalCpf,
    password: z.string().min(6, "A senha precisa de pelo menos 6 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "As senhas não conferem",
    path: ["confirmPassword"],
  });

export type SignupInput = z.infer<typeof signupSchema>;
export type SignupFormValues = z.input<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email("Email inválido"),
  password: z.string().min(1, "Informe a senha"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const resetSchema = z.object({
  email: z.string().trim().email("Email inválido"),
});

export type ResetInput = z.infer<typeof resetSchema>;

export const updatePasswordSchema = z
  .object({
    password: z.string().min(6, "A senha precisa de pelo menos 6 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "As senhas não conferem",
    path: ["confirmPassword"],
  });

export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

export const profileSchema = z.object({
  fullName: z.string().trim().min(3, "Informe seu nome completo"),
  phone,
  cpf: optionalCpf,
});

export type ProfileInput = z.infer<typeof profileSchema>;
export type ProfileFormValues = z.input<typeof profileSchema>;

export const addressSchema = z.object({
  zipCode: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 8, "CEP inválido"),
  street: z.string().trim().min(1, "Informe a rua"),
  number: z.string().trim().min(1, "Informe o número"),
  complement: z.string().trim().optional(),
  neighborhood: z.string().trim().min(1, "Informe o bairro"),
  city: z.string().trim().min(1, "Informe a cidade"),
  state: z.string().trim().length(2, "UF inválida"),
  isDefault: z.boolean().optional(),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type AddressFormValues = z.input<typeof addressSchema>;
